import { createConnection, type Socket } from 'node:net'
import { chmod, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'


// Paths are data, never PowerShell source. This helper never receives secrets.
async function windowsAcl(path: string, protect: boolean): Promise<void> {
  const { execFile } = await import('node:child_process')
  const run = promisify(execFile)
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = $env:DEARMACHINE_ACL_PATH
$item = Get-Item -LiteralPath $p -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not allowed' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Current-user ownership required' }
if ($env:DEARMACHINE_ACL_PROTECT -eq '1') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = [Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) { $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' }
  foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]'S-1-5-18')) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  # Persist only the changed DACL; Set-Acl can also try to write the SACL.
  $item.SetAccessControl($acl)
  $acl = Get-Acl -LiteralPath $p
}
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -eq 'Allow') {
    $principal = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($principal -ne $sid.Value -and $principal -ne 'S-1-5-18') { throw 'Private current-user ACL required' }
  }
}
`
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    await run(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
      env: { ...process.env, DEARMACHINE_ACL_PATH: path, DEARMACHINE_ACL_PROTECT: protect ? '1' : '0' },
    })
  } catch { throw new Error('Private current-user Windows file permissions could not be verified.') }
}

export async function protectPrivatePath(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') await windowsAcl(path, true)
  else await chmod(path, mode)
}

export async function hasPrivatePermissions(path: string, mask = 0o077): Promise<boolean> {
  if (process.platform === 'win32') {
    try { await windowsAcl(path, false); return true } catch { return false }
  }
  const metadata = await lstat(path)
  return (metadata.mode & mask) === 0
}


/** Windows uses an authenticated loopback endpoint; only its owner can read the token. */
export async function connectCredentialBridge(path: string): Promise<{ socket: Socket; token?: string }> {
  if (process.platform !== 'win32') return { socket: createConnection(path) }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 || !await hasPrivatePermissions(path)) throw new Error('Invalid private credential endpoint')
  const endpoint = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; port?: unknown; token?: unknown }
  if (endpoint.version !== 1 || typeof endpoint.port !== 'number' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string' || !/^[a-f0-9]{64}$/u.test(endpoint.token)) throw new Error('Invalid private credential endpoint')
  return { socket: createConnection({ host: '127.0.0.1', port: endpoint.port }), token: endpoint.token }
}
