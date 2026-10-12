export interface SigningPlan { signed: boolean; args: string[]; }

/** Validate only this platform's credentials; never include credential values in errors. */
export function signingPlan(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SigningPlan {
  const keys = platform === 'darwin'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
    : platform === 'win32' ? ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'] : [];
  if (!keys.some(key => !!env[key])) return { signed: false, args: [] };
  if (keys.some(key => !env[key]?.trim())) throw new Error('Incomplete platform signing configuration; refusing an implicitly unsigned build');
  if (platform === 'darwin') {
    const identity = env['CSC_NAME']!;
    if (/[\r\n\0]/u.test(identity)) throw new Error('Invalid signing identity');
    return { signed: true, args: [`--config.mac.identity=${identity}`, '--config.mac.hardenedRuntime=true', '--config.mac.notarize=true', '--config.mac.forceCodeSigning=true', '--config.dmg.sign=true'] };
  }
  return { signed: true, args: ['--config.win.signAndEditExecutable=true', '--config.win.forceCodeSigning=true'] };
}
