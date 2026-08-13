/**
 * Reads AEO engine keys/settings: app_settings → env (the same table edited by the
 * admin panel's «Настройки»/«Движки» ("Settings"/"Engines") page).
 *
 * Order follows Python: settings_store.apply_to_environ, on startup, lays the
 * NON-EMPTY values from app_settings OVER os.environ (`os.environ[k]=v if v`), so
 * an admin-panel edit WINS over the .env value for the running process. That means
 * the effective order is app_settings(non-empty) → env → ''. Env-first would break
 * "admin edits without a release" for keys set in both .env and app_settings.
 * A separate module so the dispatcher and the providers don't form an import cycle.
 * app_settings cache — 60s inside getAppSettings.
 */
import { getAppSettings } from '../../blogwriter/server/utils/store';

/** Value of a key: app_settings(non-empty) → env → '' (never throws). */
export async function getSettingKey(name: string): Promise<string> {
  try {
    const s = await getAppSettings([name]);
    const fromDb = (s[name] || '').trim();
    if (fromDb) return fromDb; // admin edit (app_settings) overrides .env
  } catch {
    /* no table/connection — fall back to env */
  }
  return (process.env[name] || '').trim();
}
