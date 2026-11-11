/**
 * uPrint 批量打印 - preload.js  (v1.1.0 Windows 原生引擎版)
 * 运行在 uTools 预加载环境，可访问 Node.js 与 Electron 渲染层 API。
 *
 * 背景：uTools 新版基于 Electron 16+，插件环境不提供 remote / BrowserWindow，
 *      因此本版不再依赖隐藏窗口打印，改用 Windows 原生能力：
 *
 *   1. 图片静默打印：PowerShell + System.Drawing.Printing 直送打印机（系统自带，零安装）
 *      支持 纸张大小、页边距、方向、份数、缩放 全套参数
 *   2. PDF 静默打印：已安装的 SumatraPDF 命令行；未安装时使用系统关联阅读器
 *   3. Word（.docx）：通过系统关联的 Word/WPS 直送打印机
 *      系统关联程序的可用参数取决于该程序；不支持自定义页边距
 *   4. 打印机枚举：PowerShell Win32_Printer，返回系统全部打印机
 *   5. 浏览器引擎（渲染层）：PDF / 图片静默路径失败时走系统打印对话框兜底
 *
 * 对外暴露 window.uPrint 供 index.html 后加载脚本调用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

/* ----------------------------- electron 渲染层 ----------------------------- */
// uTools preload 仅提供渲染层模块；nativeImage 可用于读取图片尺寸，拿不到就算了
let electronNativeImage = null;
try {
  const electron = require('electron');
  electronNativeImage = electron.nativeImage || null;
} catch (e) {
  electronNativeImage = null;
}

/* ------------------------------- 常量定义 ------------------------------- */
const EXT = {
  pdf: ['pdf'],
  docx: ['docx'],
  image: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff'],
  office: ['doc', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'wps', 'et', 'dps']
};
// 常用纸张尺寸（毫米）
const PAPER_SIZES = {
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  B4: { width: 250, height: 353 },
  B5: { width: 176, height: 250 },
  Letter: { width: 216, height: 279 },
  Legal: { width: 216, height: 356 }
};
const IS_WIN = process.platform === 'win32';
const activeProcesses = new Set();
let exiting = false;
function trackProcess(child) {
  activeProcesses.add(child);
  child.once('close', () => activeProcesses.delete(child));
}
async function stopProcesses() {
  exiting = true;
  try {
    await Promise.all([...activeProcesses].map(child => new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.removeListener('close', done); reject(new Error('打印程序未能停止，请稍后重试。')); }, 8000);
      function done() { clearTimeout(timer); resolve(); }
      child.once('close', done);
      try { if (!child.kill() && child.exitCode === null && child.signalCode === null) throw new Error('无法停止打印程序。'); }
      catch (error) { clearTimeout(timer); child.removeListener('close', done); reject(error); }
    })));
  } catch (error) { exiting = false; throw error; }
}
if (typeof utools !== 'undefined' && typeof utools.onPluginExit === 'function') utools.onPluginExit(stopProcesses);
if (typeof utools !== 'undefined' && typeof utools.onPluginExitCancelled === 'function') utools.onPluginExitCancelled(() => { exiting = false; });

/* ------------------------------- 工具函数 ------------------------------- */
function extname(p) {
  return path.extname(p).replace('.', '').toLowerCase();
}
function fileKind(p) {
  const e = extname(p);
  if (EXT.pdf.includes(e)) return 'pdf';
  if (EXT.docx.includes(e)) return 'docx';
  if (EXT.image.includes(e)) return 'image';
  if (EXT.office.includes(e)) return 'office';
  return 'other';
}
function fileExists(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (e) { return false; }
}
function baseName(p) { return path.basename(p); }

// PDF 页数：优先取页树中最大的 /Count，避免目录等对象里的较小 Count 干扰翻页。
function pdfPageCount(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const tail = buf.slice(Math.max(0, buf.length - 131072)).toString('latin1');
    const counts = [];
    const countRe = /\/Count\s+(\d+)/g;
    let m;
    while ((m = countRe.exec(tail))) counts.push(parseInt(m[1], 10));
    if (counts.length) return Math.max.apply(Math, counts);
    const pages = tail.match(/\/Type\s*\/Page\b/g);
    if (pages) return pages.length;
    return 0;
  } catch (e) { return 0; }
}

// 图片像素尺寸（electron nativeImage；拿不到返回 null）
function imageSize(filePath) {
  try {
    if (!electronNativeImage) return null;
    const img = electronNativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const s = img.getSize();
    return { width: s.width, height: s.height };
  } catch (e) { return null; }
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    if (exiting) return resolve({ err: new Error('插件正在退出'), stdout: '', stderr: '' });
    const timeout = (opts && opts.timeout) || 60000;
    let child;
    try {
      child = execFile(cmd, args, Object.assign({ windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout }, opts || {}),
        (err, stdout, stderr) => resolve({ err: err || null, stdout: stdout || '', stderr: stderr || '' }));
      trackProcess(child);
    } catch (e) {
      resolve({ err: e, stdout: '', stderr: String(e && e.message || e) });
    }
  });
}

// PowerShell 调用：返回 { code, stdout, stderr }
function runPs(scriptOrArgs, opts) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (Array.isArray(scriptOrArgs)) args.push.apply(args, scriptOrArgs);
  else args.push('-Command', scriptOrArgs);
  return run('powershell.exe', args, opts).then((r) => ({
    code: r.err ? (r.err.code || 1) : 0,
    stdout: r.stdout,
    stderr: r.stderr,
    err: r.err
  }));
}

/* --------------------------- 打印机枚举（Windows） --------------------------- */
function getPrintersWin() {
  const ps =
    "try { $utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; " +
    "$ps = Get-CimInstance Win32_Printer | Select-Object Name, Default; " +
    "if (-not $ps) { '[]'; exit } " +
    "$out = @(); foreach ($p in $ps) { $out += [PSCustomObject]@{ name = $p.Name; isDefault = [bool]$p.Default } }; " +
    "($out | ConvertTo-Json -Compress -Depth 3) } catch { '[]' }";
  return runPs(ps, { timeout: 20000 }).then((r) => {
    if (r.code !== 0 || !r.stdout.trim()) return [];
    let txt = r.stdout.trim();
    // 多打印机时是数组，单台时 ConvertTo-Json 返回单个对象，统一包成数组
    try {
      let data = JSON.parse(txt);
      if (!Array.isArray(data)) data = [data];
      return data
        .filter(x => x && x.name)
        .map(x => ({ name: String(x.name), isDefault: !!x.isDefault, displayName: String(x.name) }));
    } catch (e) { return []; }
  });
}

/* ------------------------- 图片静默打印（PowerShell） ------------------------- */
// PS1 脚本：用 System.Drawing.Printing 将图片直送打印机
const PS_IMAGE_SCRIPT = [
  'param(',
  '  [Parameter(Mandatory=$true)][string]$ImagePath,',
  '  [string]$PrinterName = "",',
  '  [int]$Copies = 1,',
  '  [string]$Orientation = "portrait",',
  '  [double]$MarginTop = 0,',
  '  [double]$MarginBottom = 0,',
  '  [double]$MarginLeft = 0,',
  '  [double]$MarginRight = 0,',
  '  [double]$PageWidthMm = 210,',
  '  [double]$PageHeightMm = 297,',
  '  [double]$ScalePct = 100',
  ')',
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '[Console]::OutputEncoding = $utf8',
  '$OutputEncoding = $utf8',
  'Add-Type -AssemblyName System.Drawing',
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  if (-not (Test-Path -LiteralPath $ImagePath)) { Write-Output "ERROR: image-not-found"; exit 2 }',
  '  $img = [System.Drawing.Image]::FromFile($ImagePath)',
  '  $doc = New-Object System.Drawing.Printing.PrintDocument',
  '  if ($PrinterName -ne "") { $doc.PrinterSettings.PrinterName = $PrinterName }',
  '  if (-not $doc.PrinterSettings.IsValid) { Write-Output ("ERROR: invalid-printer:" + $doc.PrinterSettings.PrinterName); exit 3 }',
  '  $doc.PrinterSettings.Copies = [short]1',
  '  # 选择纸张：按纵向尺寸匹配打印机支持的纸张',
  '  $wMm = [Math]::Min($PageWidthMm, $PageHeightMm)',
  '  $hMm = [Math]::Max($PageWidthMm, $PageHeightMm)',
  '  foreach ($psize in $doc.PrinterSettings.PaperSizes) {',
  '    $pw = [Math]::Round($psize.Width / 100.0 * 25.4, 0)',
  '    $ph = [Math]::Round($psize.Height / 100.0 * 25.4, 0)',
  '    if ([Math]::Abs($pw - $wMm) -le 3 -and [Math]::Abs($ph - $hMm) -le 3) { $doc.DefaultPageSettings.PaperSize = $psize; break }',
  '  }',
  '  $doc.DefaultPageSettings.Landscape = ($Orientation -eq "landscape")',
  '  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins([int]($MarginLeft * 3.937), [int]($MarginRight * 3.937), [int]($MarginTop * 3.937), [int]($MarginBottom * 3.937))',
  '  $script:count = 0',
  '  $script:total = [Math]::Max(1, $Copies)',
  '  $handler = {',
  '    param($sender, $e)',
  '    $b = $e.MarginBounds',
  '    $g = $e.Graphics',
  '    $ratio = [Math]::Min($b.Width / $img.Width, $b.Height / $img.Height)',
  '    $ratio = $ratio * ($ScalePct / 100.0)',
  '    $dw = $img.Width * $ratio; $dh = $img.Height * $ratio',
  '    # Graphics 原点在可打印区域左上角，而 MarginBounds 以纸张边缘为基准，需扣除硬边距才能真正居中',
  '    $dx = $b.Left + ($b.Width - $dw) / 2.0 - $e.PageSettings.HardMarginX; $dy = $b.Top + ($b.Height - $dh) / 2.0 - $e.PageSettings.HardMarginY',
  '    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '    $g.DrawImage($img, [float]$dx, [float]$dy, [float]$dw, [float]$dh)',
  '    $script:count++',
  '    $e.HasMorePages = ($script:count -lt $script:total)',
  '  }',
  '  $doc.add_PrintPage($handler)',
  '  $doc.Print()',
  '  $img.Dispose()',
  '  Write-Output "OK"',
  '} catch {',
  '  Write-Output ("ERROR: " + $_.Exception.Message)',
  '  exit 1',
  '}'
].join('\r\n');

let _psScriptPath = null;
function psScriptPath() {
  if (_psScriptPath && fs.existsSync(_psScriptPath)) return _psScriptPath;
  const dir = path.join(os.tmpdir(), 'uprint-engine');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const p = path.join(dir, 'print-image.ps1');
  // UTF8 with BOM，保证 PowerShell 5.1 正确识别
  fs.writeFileSync(p, '\ufeff' + PS_IMAGE_SCRIPT, 'utf8');
  _psScriptPath = p;
  return p;
}

function printImageWin(filePath, opt) {
  const paper = opt.paperSize ? PAPER_SIZES[opt.paperSize] : null;
  let pw = paper ? paper.width : 210;
  let ph = paper ? paper.height : 297;
  if (opt.customWidth && opt.customHeight) { pw = opt.customWidth; ph = opt.customHeight; }
  const m = opt.margins || { top: 15, bottom: 15, left: 20, right: 20 };
  const args = [
    '-File', psScriptPath(),
    '-ImagePath', filePath,
    '-PrinterName', opt.printerName || '',
    '-Copies', String(Math.max(1, parseInt(opt.copies, 10) || 1)),
    '-Orientation', opt.orientation === 'landscape' ? 'landscape' : 'portrait',
    '-MarginTop', String(Number(m.top) || 0),
    '-MarginBottom', String(Number(m.bottom) || 0),
    '-MarginLeft', String(Number(m.left) || 0),
    '-MarginRight', String(Number(m.right) || 0),
    '-PageWidthMm', String(pw),
    '-PageHeightMm', String(ph),
    '-ScalePct', String(Math.max(10, Math.min(300, Number(opt.scaleFactor) || 100)))
  ];
  return runPs(args, { timeout: 120000 }).then((r) => {
    const out = (r.stdout || '').trim();
    if (r.code === 0 && /^OK/.test(out)) return { ok: true, engine: 'ps-image' };
    const errLine = out.split(/\r?\n/).find(l => l.indexOf('ERROR') === 0) || (r.stderr || '').trim();
    return { ok: false, engine: 'ps-image', reason: 'ps-image-fail:' + (errLine || ('exit-' + r.code)).slice(0, 160) };
  });
}

/* ------------------------- PDF 原生打印（Windows.Data.Pdf） ------------------------- */
// Windows 10/11 自带的 Windows.Data.Pdf 可将每页渲染为位图，再交由 PrintDocument 发送到指定打印机。
const PS_PDF_SCRIPT = [
  'param(',
  '  [Parameter(Mandatory=$true)][string]$PdfPath,',
  '  [string]$PrinterName = "",',
  '  [int]$Copies = 1,',
  '  [string]$Orientation = "portrait",',
  '  [double]$MarginTop = 0,',
  '  [double]$MarginBottom = 0,',
  '  [double]$MarginLeft = 0,',
  '  [double]$MarginRight = 0,',
  '  [double]$PageWidthMm = 210,',
  '  [double]$PageHeightMm = 297,',
  '  [double]$ScalePct = 100,',
  '  [string]$PageRanges = "",',
  '  [switch]$Preview,',
  '  [int]$PreviewPage = 0,',
  '  [switch]$TrimWhite',
  ')',
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '[Console]::OutputEncoding = $utf8',
  '$OutputEncoding = $utf8',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$ErrorActionPreference = "Stop"',
  // 内容边界检测：找出非白色像素的外接矩形，用于把 Word 页面里的实际内容居中（忽略文档自身不对称的页边距）
  'if ($TrimWhite) { Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition "using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; public static class UPrintTrim { public static int[] Bounds(Bitmap bmp, int threshold) { Rectangle rect = new Rectangle(0, 0, bmp.Width, bmp.Height); BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb); try { int stride = Math.Abs(data.Stride); byte[] buf = new byte[stride * bmp.Height]; Marshal.Copy(data.Scan0, buf, 0, buf.Length); int minX = bmp.Width, minY = bmp.Height, maxX = -1, maxY = -1; for (int y = 0; y < bmp.Height; y++) { int row = y * stride; for (int x = 0; x < bmp.Width; x++) { int i = row + x * 4; if (buf[i + 3] < 16) continue; if (buf[i] >= threshold && buf[i + 1] >= threshold && buf[i + 2] >= threshold) continue; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } if (maxX < 0) return new int[] { 0, 0, bmp.Width, bmp.Height }; return new int[] { minX, minY, maxX - minX + 1, maxY - minY + 1 }; } finally { bmp.UnlockBits(data); } } }" }',
  'function Await-Operation($operation, [type]$resultType) {',
  "  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
  '  return $method.MakeGenericMethod($resultType).Invoke($null, (, $operation)).GetAwaiter().GetResult()',
  '}',
  'function Await-Action($action) {',
  '  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and -not $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction" } | Select-Object -First 1',
  '  $method.Invoke($null, (, $action)).GetAwaiter().GetResult() | Out-Null',
  '}',
  'function Get-PageIndexes([int]$total, [string]$ranges) {',
  '  $out = New-Object "System.Collections.Generic.List[int]"',
  '  if ([string]::IsNullOrWhiteSpace($ranges)) { for ($i = 0; $i -lt $total; $i++) { $out.Add($i) }; return $out.ToArray() }',
  '  foreach ($part in $ranges.Split(",")) {',
  '    if ($part -match "^\\s*(\\d+)(?:\\s*-\\s*(\\d+))?\\s*$") {',
  '      $start = [int]$Matches[1]; $end = if ($Matches[2]) { [int]$Matches[2] } else { $start }',
  '      if ($start -le $end) { for ($i = [Math]::Max(0, $start); $i -le [Math]::Min($total - 1, $end); $i++) { if (-not $out.Contains($i)) { $out.Add($i) } } }',
  '    }',
  '  }',
  '  if ($out.Count -eq 0) { throw "没有可打印的 PDF 页码" }',
  '  return $out.ToArray()',
  '}',
  'function Get-PdfPageImage($pdf, [int]$pageIndex) {',
  '  $page = $pdf.GetPage($pageIndex)',
  '  try {',
  '    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream',
  '    try {',
  '      $options = New-Object ([Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime])',
  '      $options.DestinationWidth = [uint32][Math]::Max(1, [Math]::Round($page.Size.Width * 2))',
  '      $options.DestinationHeight = [uint32][Math]::Max(1, [Math]::Round($page.Size.Height * 2))',
  '      Await-Action ($page.RenderToStreamAsync($stream, $options))',
  '      $input = $stream.GetInputStreamAt(0)',
  '      try {',
  '        $reader = New-Object Windows.Storage.Streams.DataReader($input)',
  '        try {',
  '          Await-Operation ($reader.LoadAsync($stream.Size)) ([uint32]) | Out-Null',
  '          $bytes = New-Object byte[] ([int]$stream.Size); $reader.ReadBytes($bytes)',
  '          $memory = New-Object System.IO.MemoryStream (, $bytes)',
  '          try { $source = [System.Drawing.Image]::FromStream($memory); try { $bmp = [System.Drawing.Bitmap]::new($source) } finally { $source.Dispose() } } finally { $memory.Dispose() }',
  '          $w = $page.Size.Width; $h = $page.Size.Height',
  '          if ($TrimWhite) {',
  '            $r = [UPrintTrim]::Bounds($bmp, 245); $pad = [int][Math]::Round($bmp.Width / $page.Size.Width * 96.0 / 25.4 * 2.0)',
  '            $x0 = [Math]::Max(0, $r[0] - $pad); $y0 = [Math]::Max(0, $r[1] - $pad); $x1 = [Math]::Min($bmp.Width, $r[0] + $r[2] + $pad); $y1 = [Math]::Min($bmp.Height, $r[1] + $r[3] + $pad)',
  '            if (($x1 - $x0) -lt $bmp.Width -or ($y1 - $y0) -lt $bmp.Height) {',
  '              $crop = $bmp.Clone((New-Object System.Drawing.Rectangle($x0, $y0, ($x1 - $x0), ($y1 - $y0))), $bmp.PixelFormat)',
  '              $w = $page.Size.Width * ($x1 - $x0) / $bmp.Width; $h = $page.Size.Height * ($y1 - $y0) / $bmp.Height; $bmp.Dispose(); $bmp = $crop',
  '            }',
  '          }',
  '          return [PSCustomObject]@{ Image = $bmp; Width = $w; Height = $h }',
  '        } finally { $reader.Dispose() }',
  '      } finally { $input.Dispose() }',
  '    } finally { $stream.Dispose() }',
  '  } finally { $page.Dispose() }',
  '}',
  'try {',
  '  if (-not (Test-Path -LiteralPath $PdfPath)) { Write-Output "ERROR: pdf-not-found"; exit 2 }',
  '  $doc = New-Object System.Drawing.Printing.PrintDocument',
  '  if ($PrinterName -ne "") { $doc.PrinterSettings.PrinterName = $PrinterName }',
  '  if (-not $doc.PrinterSettings.IsValid) { Write-Output ("ERROR: invalid-printer:" + $doc.PrinterSettings.PrinterName); exit 3 }',
  '  $wMm = [Math]::Min($PageWidthMm, $PageHeightMm); $hMm = [Math]::Max($PageWidthMm, $PageHeightMm)',
  '  foreach ($psize in $doc.PrinterSettings.PaperSizes) { $pw = [Math]::Round($psize.Width / 100.0 * 25.4, 0); $ph = [Math]::Round($psize.Height / 100.0 * 25.4, 0); if ([Math]::Abs($pw - $wMm) -le 3 -and [Math]::Abs($ph - $hMm) -le 3) { $doc.DefaultPageSettings.PaperSize = $psize; break } }',
  '  $doc.DefaultPageSettings.Landscape = ($Orientation -eq "landscape")',
  '  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins([int]($MarginLeft * 3.937), [int]($MarginRight * 3.937), [int]($MarginTop * 3.937), [int]($MarginBottom * 3.937))',
  '  $file = Await-Operation ([Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime])',
  '  $pdf = Await-Operation ([Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime])',
  '  if ($Preview) {',
  '    $index = [Math]::Max(0, [Math]::Min($pdf.PageCount - 1, $PreviewPage)); $rendered = Get-PdfPageImage $pdf $index',
  '    try { $memory = New-Object System.IO.MemoryStream; try { $rendered.Image.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output ("PREVIEW:" + $pdf.PageCount + ":" + $rendered.Width + ":" + $rendered.Height + ":" + [Convert]::ToBase64String($memory.ToArray())) } finally { $memory.Dispose() } } finally { $rendered.Image.Dispose() }',
  '    return',
  '  }',
  '  $pages = Get-PageIndexes $pdf.PageCount $PageRanges; $queue = New-Object "System.Collections.Generic.List[int]"',
  '  for ($copy = 0; $copy -lt [Math]::Max(1, $Copies); $copy++) { foreach ($pageIndex in $pages) { $queue.Add($pageIndex) } }',
  '  $script:queueIndex = 0',
  '  $handler = {',
  '    param($sender, $e)',
  '    $rendered = Get-PdfPageImage $pdf $queue[$script:queueIndex]; $img = $rendered.Image',
  '    try {',
  '      $b = $e.MarginBounds; $dw = ($rendered.Width / 96.0) * 100.0 * ($ScalePct / 100.0); $dh = ($rendered.Height / 96.0) * 100.0 * ($ScalePct / 100.0)',
  '      $fit = [Math]::Min(1.0, [Math]::Min($b.Width / $dw, $b.Height / $dh)); $dw *= $fit; $dh *= $fit; $dx = $b.Left + ($b.Width - $dw) / 2.0 - $e.PageSettings.HardMarginX; $dy = $b.Top + ($b.Height - $dh) / 2.0 - $e.PageSettings.HardMarginY',
  '      $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '      $e.Graphics.DrawImage($img, [float]$dx, [float]$dy, [float]$dw, [float]$dh)',
  '    } finally { $img.Dispose() }',
  '    $script:queueIndex++; $e.HasMorePages = ($script:queueIndex -lt $queue.Count)',
  '  }',
  '  $doc.add_PrintPage($handler); $doc.Print(); Write-Output "OK"',
  '} catch { Write-Output ("ERROR line " + $_.InvocationInfo.ScriptLineNumber + ": " + $_.Exception.Message); exit 1 }'
].join('\r\n');

let _psPdfScriptPath = null;
function psPdfScriptPath() {
  if (_psPdfScriptPath && fs.existsSync(_psPdfScriptPath)) return _psPdfScriptPath;
  const dir = path.join(os.tmpdir(), 'uprint-engine');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const p = path.join(dir, 'print-pdf.ps1');
  fs.writeFileSync(p, '\ufeff' + PS_PDF_SCRIPT, 'utf8');
  _psPdfScriptPath = p;
  return p;
}

function printPdfWin(filePath, opt) {
  const paper = opt.paperSize ? PAPER_SIZES[opt.paperSize] : null;
  let pw = paper ? paper.width : 210;
  let ph = paper ? paper.height : 297;
  if (opt.customWidth && opt.customHeight) { pw = opt.customWidth; ph = opt.customHeight; }
  const m = opt.margins || { top: 15, bottom: 15, left: 20, right: 20 };
  const args = [
    '-File', psPdfScriptPath(), '-PdfPath', filePath, '-PrinterName', opt.printerName || '',
    '-Copies', String(Math.max(1, parseInt(opt.copies, 10) || 1)),
    '-Orientation', opt.orientation === 'landscape' ? 'landscape' : 'portrait',
    '-MarginTop', String(Number(m.top) || 0), '-MarginBottom', String(Number(m.bottom) || 0),
    '-MarginLeft', String(Number(m.left) || 0), '-MarginRight', String(Number(m.right) || 0),
    '-PageWidthMm', String(pw), '-PageHeightMm', String(ph),
    '-ScalePct', String(Math.max(10, Math.min(300, Number(opt.scaleFactor) || 100))),
    '-PageRanges', opt.pageRanges || ''
  ];
  if (opt.trimWhite) args.push('-TrimWhite');
  return runPs(args, { timeout: 300000 }).then((r) => {
    const out = (r.stdout || '').trim();
    if (r.code === 0 && /^OK/.test(out)) return { ok: true, engine: 'windows-pdf' };
    const errLine = out.split(/\r?\n/).find(l => l.indexOf('ERROR') === 0) || (r.stderr || '').trim();
    return { ok: false, engine: 'windows-pdf', reason: 'windows-pdf-fail:' + (errLine || ('exit-' + r.code)).slice(0, 160) };
  });
}

function renderPdfPreview(filePath, pageIndex, trimWhite) {
  const args = ['-File', psPdfScriptPath(), '-PdfPath', filePath, '-Preview', '-PreviewPage', String(Math.max(0, Number(pageIndex) || 0))];
  if (trimWhite) args.push('-TrimWhite');
  return runPs(args, { timeout: 120000 }).then((r) => {
    const match = (r.stdout || '').trim().match(/^PREVIEW:(\d+):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?):([A-Za-z0-9+/=]+)$/);
    if (r.code === 0 && match) return { ok: true, pages: Number(match[1]), width: Number(match[2]), height: Number(match[3]), dataUrl: 'data:image/png;base64,' + match[4] };
    const errLine = (r.stdout || '').trim().split(/\r?\n/).find(l => l.indexOf('ERROR') === 0) || (r.stderr || '').trim();
    return { ok: false, reason: (errLine || '无法生成 PDF 预览').slice(0, 160) };
  });
}

/* ----------------------------- SumatraPDF 引擎 ----------------------------- */
const SUMATRA_CANDIDATES = [
  'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
  'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe'
];
function managedSumatraPath() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'uPrint', 'SumatraPDF', 'SumatraPDF.exe');
}
function regQuerySumatra() {
  return run('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\SumatraPDF.exe', '/ve'], { timeout: 8000 })
    .then((r) => {
      if (r.err || !r.stdout) return null;
      const m = r.stdout.match(/REG_SZ\s+(.+)/);
      if (m) { const p = m[1].trim().replace(/^"|"$/g, ''); if (p && fs.existsSync(p)) return p; }
      return null;
    })
    .catch(() => null);
}
function findSumatra() {
  if (!IS_WIN) return Promise.resolve(null);
  return new Promise((resolve) => {
    const cands = SUMATRA_CANDIDATES.slice();
    cands.push(managedSumatraPath());
    const next = () => {
      if (!cands.length) {
        regQuerySumatra().then((p) => {
          if (p) return resolve(p);
          run('where.exe', ['SumatraPDF'], { timeout: 8000 }).then((r) => {
            if (!r.err && r.stdout) { const p2 = r.stdout.split(/\r?\n/)[0].trim(); if (p2 && fs.existsSync(p2)) return resolve(p2); }
            resolve(null);
          });
        });
        return;
      }
      const p = cands.shift();
      fs.access(p, fs.constants.F_OK, (err) => { if (!err) resolve(p); else next(); });
    };
    next();
  });
}

// SumatraPDF 的 -print-settings 只能出现一次，需合并
function buildSumatraSettings(opt) {
  const settings = [];
  settings.push(opt.orientation === 'landscape' ? 'landscape' : 'portrait');
  // 纸张：只传驱动通用的标准名；B 系/自定义不传，用打印机默认
  if (opt.paperSize && ['A3', 'A4', 'A5', 'Letter', 'Legal'].indexOf(opt.paperSize) >= 0) {
    settings.push(opt.paperSize.toLowerCase());
  }
  const copies = Math.max(1, parseInt(opt.copies, 10) || 1);
  if (copies > 1) settings.push(copies + 'x');
  if (opt.pageRanges) {
    // app 层传入的是 Electron 风格 0 基，这里转 1 基
    const r = opt.pageRanges.split(',').map(seg => {
      const parts = seg.split('-').map(n => parseInt(n, 10) + 1);
      return parts.length > 1 ? parts[0] + '-' + parts[1] : String(parts[0]);
    }).join(',');
    settings.push(r);
  }
  return settings.join(',');
}

function printWithSumatra(filePath, opt, exePath) {
  return new Promise((resolve) => {
    if (exiting) return resolve({ ok: false, engine: 'sumatra', reason: '插件正在退出' });
    const args = [];
    if (opt.printerName) args.push('-print-to', opt.printerName);
    else args.push('-print-to-default');
    args.push('-silent', '-exit-when-done', '-print-settings', buildSumatraSettings(opt), filePath);
    let child;
    try {
      child = execFile(exePath, args, { windowsHide: true, timeout: 90000 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, engine: 'sumatra', reason: 'sumatra:' + (String(err.message || err)).slice(0, 160) });
        resolve({ ok: true, engine: 'sumatra' });
      });
      trackProcess(child);
    } catch (e) {
      resolve({ ok: false, engine: 'sumatra', reason: String(e && e.message || e) });
    }
  });
}

// 交给文件关联程序处理。选了打印机时优先调用 PrintTo。
function printWithAssociatedApp(filePath, opt, failReason) {
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const printerName = opt && opt.printerName ? String(opt.printerName) : '';
  const ps = "$ErrorActionPreference = 'Stop'; " +
    (printerName
      ? "Start-Process -FilePath " + quote(filePath) + " -Verb PrintTo -ArgumentList " + quote(printerName)
      : "Start-Process -FilePath " + quote(filePath) + " -Verb Print") + "; Write-Output 'OK'";
  return runPs(ps, { timeout: 30000 }).then((r) => {
    if (r.code === 0 && /^OK/.test((r.stdout || '').trim())) {
      return { ok: true, engine: printerName ? 'shell-printto' : 'shell-print', silent: false };
    }
    return { ok: false, engine: 'shell-verb', reason: failReason };
  });
}

/* ----------------------------- Word（WPS）打印 ----------------------------- */
const PS_DOCX_SCRIPT = [
  'param([Parameter(Mandatory=$true)][string]$DocxPath, [string]$PrinterName = "", [int]$Copies = 1)',
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '[Console]::OutputEncoding = $utf8',
  '$OutputEncoding = $utf8',
  '$ErrorActionPreference = "Stop"',
  '$app = $null; $doc = $null',
  'try {',
  '  if (-not (Test-Path -LiteralPath $DocxPath)) { Write-Output "ERROR: docx-not-found"; exit 2 }',
  '  $app = New-Object -ComObject Kwps.Application',
  '  $app.Visible = $false',
  '  if ($PrinterName -ne "") { $app.ActivePrinter = $PrinterName }',
  '  $doc = $app.Documents.Open($DocxPath)',
  '  for ($i = 0; $i -lt [Math]::Max(1, $Copies); $i++) { $doc.PrintOut($false) }',
  '  Write-Output "OK"',
  '} catch { Write-Output ("ERROR: " + $_.Exception.Message); exit 1 }',
  'finally { if ($doc -ne $null) { try { $doc.Close(0) } catch {} }; if ($app -ne $null) { try { $app.Quit() } catch {} } }'
].join('\r\n');

const PS_DOCX_PREVIEW_SCRIPT = [
  'param([Parameter(Mandatory=$true)][string]$DocxPath, [Parameter(Mandatory=$true)][string]$PdfPath)',
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '[Console]::OutputEncoding = $utf8',
  '$OutputEncoding = $utf8',
  '$ErrorActionPreference = "Stop"',
  '$app = $null; $doc = $null',
  'try {',
  '  if (-not (Test-Path -LiteralPath $DocxPath)) { Write-Output "ERROR: docx-not-found"; exit 2 }',
  '  $app = New-Object -ComObject Kwps.Application; $app.Visible = $false',
  '  $doc = $app.Documents.Open($DocxPath)',
  '  $doc.ExportAsFixedFormat($PdfPath, 17)',
  '  if (-not (Test-Path -LiteralPath $PdfPath)) { throw "WPS 未生成 PDF 预览文件" }',
  '  Write-Output "OK"',
  '} catch { Write-Output ("ERROR: " + $_.Exception.Message); exit 1 }',
  'finally { if ($doc -ne $null) { try { $doc.Close(0) } catch {} }; if ($app -ne $null) { try { $app.Quit() } catch {} } }'
].join('\r\n');

let _psDocxScriptPath = null;
let _psDocxPreviewScriptPath = null;
function psDocxScriptPath() {
  if (_psDocxScriptPath && fs.existsSync(_psDocxScriptPath)) return _psDocxScriptPath;
  const dir = path.join(os.tmpdir(), 'uprint-engine');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const p = path.join(dir, 'print-docx.ps1');
  fs.writeFileSync(p, '\ufeff' + PS_DOCX_SCRIPT, 'utf8');
  _psDocxScriptPath = p;
  return p;
}
function psDocxPreviewScriptPath() {
  if (_psDocxPreviewScriptPath && fs.existsSync(_psDocxPreviewScriptPath)) return _psDocxPreviewScriptPath;
  const dir = path.join(os.tmpdir(), 'uprint-engine');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const p = path.join(dir, 'preview-docx.ps1');
  fs.writeFileSync(p, '\ufeff' + PS_DOCX_PREVIEW_SCRIPT, 'utf8');
  _psDocxPreviewScriptPath = p;
  return p;
}

function printDocxWithWps(filePath, opt) {
  const args = ['-File', psDocxScriptPath(), '-DocxPath', filePath, '-PrinterName', opt.printerName || '', '-Copies', String(Math.max(1, parseInt(opt.copies, 10) || 1))];
  return runPs(args, { timeout: 180000 }).then((r) => {
    const out = (r.stdout || '').trim();
    if (r.code === 0 && /^OK/.test(out)) return { ok: true, engine: 'wps-docx' };
    const errLine = out.split(/\r?\n/).find(l => l.indexOf('ERROR') === 0) || (r.stderr || '').trim();
    return { ok: false, engine: 'wps-docx', reason: 'docx-print-failed:' + (errLine || ('exit-' + r.code)).slice(0, 160) };
  });
}

function prepareDocxPreview(filePath) {
  const dir = path.join(os.tmpdir(), 'uprint-engine');
  const pdfPath = path.join(dir, 'docx-preview-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.pdf');
  const args = ['-File', psDocxPreviewScriptPath(), '-DocxPath', filePath, '-PdfPath', pdfPath];
  return runPs(args, { timeout: 180000 }).then((r) => {
    const out = (r.stdout || '').trim();
    if (r.code === 0 && /^OK/.test(out) && fileExists(pdfPath)) return { ok: true, pdfPath, pages: pdfPageCount(pdfPath) };
    try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch (e) {}
    const errLine = out.split(/\r?\n/).find(l => l.indexOf('ERROR') === 0) || (r.stderr || '').trim();
    return { ok: false, reason: (errLine || 'WPS 无法生成 Word 预览').slice(0, 160) };
  });
}

// Word 打印：先用 WPS 导出临时 PDF，再走与 PDF 相同的原生打印流程，
// 这样纸张、页边距、缩放、居中设置才会生效；同时裁掉文档自身的空白页边距，让实际内容居中。
async function printDocxWin(filePath, opt) {
  const prep = await prepareDocxPreview(filePath);
  // 导出失败时退回 WPS 直接打印（此时按文档自身版式输出，设置不生效）
  if (!prep.ok) return printDocxWithWps(filePath, opt);
  try {
    const r = await printPdfWin(prep.pdfPath, Object.assign({}, opt, { trimWhite: true }));
    return Object.assign({}, r, { engine: r.ok ? 'wps-pdf' : r.engine });
  } finally {
    removePreviewFile(prep.pdfPath);
  }
}

function removePreviewFile(filePath) {
  const dir = path.join(os.tmpdir(), 'uprint-engine');
  if (!filePath || path.dirname(filePath) !== dir || !/^docx-preview-.*\.pdf$/i.test(path.basename(filePath))) return;
  try { fs.unlinkSync(filePath); } catch (e) {}
}

/* ------------------------------- 环境检测 ------------------------------- */
function detectEnv() {
  if (!IS_WIN) {
    return Promise.resolve({
      platform: process.platform, engine: 'browser',
      pdfSilent: false, imageSilent: false, sumatraPath: null,
      note: '当前系统暂不支持静默打印，图片可走系统打印对话框'
    });
  }
  return findSumatra().then((sumatra) => ({
    platform: 'win32',
    engine: 'windows-native',
    sumatraPath: sumatra || null,
    pdfSilent: true,
    imageSilent: true, // PowerShell System.Drawing，Windows 自带
    note: '静默引擎就绪：PDF 和图片均使用 Windows 原生打印组件'
  }));
}

/* ------------------------------- 批量打印 ------------------------------- */
async function printFiles(files, opt, onProgress) {
  const env = await detectEnv();
  if (exiting) throw new Error('插件正在退出');
  const results = [];
  let okCount = 0;
  for (let i = 0; i < files.length; i++) {
    if (exiting) throw new Error('插件正在退出');
    const f = files[i];
    const name = baseName(f);
    const kind = fileKind(f);
    onProgress && onProgress({ index: i, total: files.length, file: f, name, status: 'printing' });

    if (!fileExists(f)) {
      results.push({ file: f, name, ok: false, reason: '文件不存在' });
      onProgress && onProgress({ index: i, total: files.length, file: f, name, status: 'done', ok: false, reason: '文件不存在' });
      continue;
    }
    if (kind === 'office' || kind === 'other') {
      const reason = kind === 'office' ? 'Office 文档请先另存为 PDF 再批量打印' : '不支持的文件类型';
      results.push({ file: f, name, ok: false, reason });
      onProgress && onProgress({ index: i, total: files.length, file: f, name, status: 'done', ok: false, reason });
      continue;
    }

    let r = { ok: false, reason: 'no-engine' };

    if (kind === 'pdf') {
      r = await printPdfWin(f, opt);
    } else if (kind === 'docx') {
      r = await printDocxWin(f, opt);
    } else if (kind === 'image') {
      if (IS_WIN) {
        r = await printImageWin(f, opt);
      }
      if (!r.ok) {
        // 静默失败（如 webp 不被 GDI+ 支持）交给渲染层浏览器对话框兜底
        r = { ok: false, engine: 'browser', reason: 'use-browser-print' + (r.reason ? ':' + r.reason : '') };
      }
    }

    if (exiting) throw new Error('插件正在退出');
    if (r.ok) okCount++;
    results.push({ file: f, name, ok: r.ok, engine: r.engine, reason: r.ok ? '' : r.reason });
    onProgress && onProgress({ index: i, total: files.length, file: f, name, status: 'done', ok: r.ok, engine: r.engine, reason: r.reason });
  }
  return { okCount, failCount: files.length - okCount, results, engine: env.engine };
}

/* ------------------------------ 设置持久化 ------------------------------ */
const SETTINGS_KEY = 'uprint-settings-v1';
function saveSettings(obj) {
  try {
    if (typeof utools !== 'undefined' && utools.dbStorage) utools.dbStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
    else localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
  } catch (e) {}
}
function loadSettings() {
  try {
    let raw = null;
    if (typeof utools !== 'undefined' && utools.dbStorage) raw = utools.dbStorage.getItem(SETTINGS_KEY);
    else raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/* ------------------------------- 对外暴露 ------------------------------- */
window.uPrint = {
  version: '1.1.0',
  fileKind,
  baseName,
  fileExists,
  pdfPageCount,
  imageSize,
  paperSizes: PAPER_SIZES,
  detectEnv,
  getPrinters: IS_WIN ? getPrintersWin : () => Promise.resolve([]),
  printFiles,
  renderPdfPreview,
  prepareDocxPreview,
  removePreviewFile,
  saveSettings,
  loadSettings,
  findSumatra,
  fileUrl: (p) => pathToFileURL(p).href
};

/* ------------------------------ uTools 事件 ------------------------------ */
if (typeof utools !== 'undefined') {
  utools.onPluginEnter(({ type, payload }) => {
    let files = [];
    if (type === 'files' && Array.isArray(payload)) files = payload;
    else if (type === 'files' && payload && payload.isFile) files = [payload.path];
    else if (typeof payload === 'string' && fileExists(payload)) files = [payload];
    if (files.length) window.dispatchEvent(new CustomEvent('uprint-files', { detail: files }));
  });
}
