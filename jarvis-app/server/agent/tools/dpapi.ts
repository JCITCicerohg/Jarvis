import { spawn } from 'node:child_process';

/**
 * Windows DPAPI (CurrentUser scope) through PowerShell's ProtectedData, so secrets on
 * disk are only readable by this Windows account. Avoids a native Node module.
 */
function run(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const full = 'Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); ' + script;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error('DPAPI failed: ' + err.trim()))));
    p.stdin.end(input);
  });
}

export const protect = (plain: string) =>
  run("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in), $null, 'CurrentUser'))",
    Buffer.from(plain, 'utf8').toString('base64'));

export const unprotect = async (b64: string) =>
  Buffer.from(await run("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'))", b64), 'base64').toString('utf8');
