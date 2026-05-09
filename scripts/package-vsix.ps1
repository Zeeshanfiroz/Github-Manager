$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$packagePath = Join-Path $root "package.json"
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$name = $package.name
$version = $package.version
$publisher = $package.publisher
$displayName = $package.displayName
$description = $package.description
$categories = ($package.categories -join ",")

function Escape-Xml([string]$value) {
  return [System.Security.SecurityElement]::Escape($value)
}

function Remove-In-Workspace([string]$path) {
  if (Test-Path -LiteralPath $path) {
    $resolved = (Resolve-Path -LiteralPath $path).Path
    if (-not $resolved.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove outside workspace: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

$dist = Join-Path $root "dist"
$temp = Join-Path $root ".vsix-build"
$zipPath = Join-Path $dist "$name-$version.zip"
$vsixPath = Join-Path $dist "$name-$version.vsix"

Remove-In-Workspace $temp
New-Item -ItemType Directory -Force -Path $dist | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $temp "_rels") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $temp "extension") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $temp "extension\src") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $temp "extension\media") | Out-Null

Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination (Join-Path $temp "extension\package.json")
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $temp "extension\README.md")
Copy-Item -LiteralPath (Join-Path $root "src\extension.js") -Destination (Join-Path $temp "extension\src\extension.js")
Copy-Item -LiteralPath (Join-Path $root "media\dashboard.js") -Destination (Join-Path $temp "extension\media\dashboard.js")
Copy-Item -LiteralPath (Join-Path $root "media\dashboard.css") -Destination (Join-Path $temp "extension\media\dashboard.css")
Copy-Item -LiteralPath (Join-Path $root "media\icon.svg") -Destination (Join-Path $temp "extension\media\icon.svg")

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="css" ContentType="text/css"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
</Types>
'@

$relationships = @'
<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/developer/2011/08/vsx-schema#VSIXManifest" Target="extension.vsixmanifest"/>
</Relationships>
'@

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Escape-Xml $name)" Version="$(Escape-Xml $version)" Publisher="$(Escape-Xml $publisher)"/>
    <DisplayName>$(Escape-Xml $displayName)</DisplayName>
    <Description xml:space="preserve">$(Escape-Xml $description)</Description>
    <Categories>$(Escape-Xml $categories)</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Code.Readme" Path="extension/README.md" Addressable="true"/>
  </Assets>
</PackageManifest>
"@

Set-Content -LiteralPath (Join-Path $temp "[Content_Types].xml") -Value $contentTypes -Encoding UTF8
Set-Content -LiteralPath (Join-Path $temp "_rels\.rels") -Value $relationships -Encoding UTF8
Set-Content -LiteralPath (Join-Path $temp "extension.vsixmanifest") -Value $manifest -Encoding UTF8

Remove-In-Workspace $zipPath
Remove-In-Workspace $vsixPath
$packageItems = Get-ChildItem -LiteralPath $temp -Force
Compress-Archive -LiteralPath $packageItems.FullName -DestinationPath $zipPath -Force
Move-Item -LiteralPath $zipPath -Destination $vsixPath
Remove-In-Workspace $temp

Write-Host "Created $vsixPath"
