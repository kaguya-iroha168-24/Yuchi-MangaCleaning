param([string]$RequestPath,[switch]$Serve)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Console]::OutputEncoding
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Operation($Operation,[Type]$ResultType) {
 $task=$asTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
 return $task.GetAwaiter().GetResult()
}
function Invoke-OcrRequest([string]$Path) {
 $request=Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
 $watch=[System.Diagnostics.Stopwatch]::StartNew()
 $timings=@{}
 $bitmap=$null
 $stream=$null
 try {
  Write-Output 'OCR stage: English image decoding'
  $file=Await-Operation ([Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]::GetFileFromPathAsync($request.input)) ([Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime])
  $stream=Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime])
  $decoder=Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime])
  if([Math]::Max($decoder.PixelWidth,$decoder.PixelHeight) -gt [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::MaxImageDimension){throw 'OCR crop exceeds the Windows engine limit. Select a smaller text region.'}
  $bitmap=Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime])
  $timings.preprocessing=$watch.Elapsed.TotalSeconds
  if($null -eq $script:engine){
   $language=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]::new('en-US')
   $script:engine=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::TryCreateFromLanguage($language)
   if($null -eq $script:engine){throw 'English Windows OCR language is unavailable. No installation was attempted.'}
  }
  $started=$watch.Elapsed.TotalSeconds
  Write-Output 'OCR stage: English text detection and recognition'
  $recognized=Await-Operation ($script:engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime])
  $timings.recognition=$watch.Elapsed.TotalSeconds-$started
  $lines=@($recognized.Lines | ForEach-Object {$_.Text})
  $warnings=@('Confidence unavailable; human review required.','English OCR may miss stylized, small or mixed-script manga lettering. Verify against the original crop.')
  if($lines.Count -eq 0){$warnings+='No text recognized. Keep the source transcription or enter it manually.'}
  $payload=@{ok=$true;result=@{text=($lines -join "`n");confidence=$null;provider='windows_ocr';language='en';device='cpu';model_id='Windows.Media.Ocr/en-US';duration_s=$watch.Elapsed.TotalSeconds;timings_s=$timings;normalization='Unicode preserved; lines joined with newline';warnings=$warnings}}
 } catch {$payload=@{ok=$false;error=$_.Exception.Message}}
 finally {if($bitmap){$bitmap.Dispose()};if($stream){$stream.Dispose()}}
 [System.IO.File]::WriteAllText($request.output + '.tmp',($payload | ConvertTo-Json -Depth 8),[System.Text.UTF8Encoding]::new($false))
 [System.IO.File]::Move($request.output + '.tmp', $request.output)
}

if($Serve){
 while($null -ne ($path=[Console]::ReadLine())){
  Invoke-OcrRequest $path
 }
} elseif($RequestPath){
 Invoke-OcrRequest $RequestPath
} else {
 throw 'Specify -RequestPath or -Serve.'
}
