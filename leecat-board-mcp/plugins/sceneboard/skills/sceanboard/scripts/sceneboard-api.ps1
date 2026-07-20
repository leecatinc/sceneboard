[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('describe', 'pair', 'invoke')]
  [string] $Action,

  [Parameter(Position = 1)]
  [string] $Operation,

  [Parameter(ValueFromPipeline = $true)]
  [AllowEmptyString()]
  [string] $InputObject
)

begin {
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $inputBuilder = [System.Text.StringBuilder]::new()
}

process {
  if ($null -ne $InputObject) {
    [void] $inputBuilder.Append($InputObject)
  }
}

end {
  if ($Action -eq 'invoke' -and [string]::IsNullOrWhiteSpace($Operation)) {
    throw 'SceneBoard invoke requires one official operation name.'
  }
  if ($Action -ne 'invoke' -and -not [string]::IsNullOrWhiteSpace($Operation)) {
    throw "SceneBoard $Action does not accept an operation name."
  }

  $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
  $adapter = Join-Path $PSScriptRoot 'sceneboard-api.mjs'
  $arguments = @($adapter, $Action)
  if ($Action -eq 'invoke') {
    $arguments += $Operation
  }

  if ($Action -eq 'describe') {
    & $node @arguments
  }
  else {
    $payload = $inputBuilder.ToString()
    if ([string]::IsNullOrWhiteSpace($payload)) {
      throw "SceneBoard $Action requires exactly one JSON object on stdin."
    }
    $payload | & $node @arguments
  }

  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
