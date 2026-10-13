import { chmod, lstat, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FlashActError } from '../utils/errors.js';

export async function privateHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new FlashActError('GUARD_REJECTED', 'IPC home must be a real directory');
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $p='${home.replaceAll("'", "''")}'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
      '$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); ' +
      '$acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule(' +
      '$sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl';
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10_000 });
  } else {
    if (info.uid !== process.getuid?.()) throw new FlashActError('GUARD_REJECTED', 'IPC home belongs to another user');
    await chmod(home, 0o700);
  }
}

export async function checkPrivate(path: string, directory = false): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
    throw new FlashActError('GUARD_REJECTED', 'IPC metadata must not be a symbolic link');
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    throw new FlashActError('GUARD_REJECTED', 'IPC metadata is not owner-only');
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $p='${path.replaceAll("'", "''")}'; ` +
      '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; ' +
      'if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw "Owner mismatch"}; ' +
      'foreach($rule in $acl.Access){if($rule.AccessControlType -eq "Allow" -and ' +
      '$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw "Nonprivate ACL"}}';
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10_000 });
  }
}
