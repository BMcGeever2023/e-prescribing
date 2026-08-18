// ---------------------------------------------------------------------------
// Supabase client. Loads supabase-js straight from a CDN as an ES module, so
// there is no build step (matching the rest of this project). Reads config
// from window.PORTAL_CONFIG, which js/config.js sets before this module runs.
// ---------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.PORTAL_CONFIG || {};
const configured =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes('YOUR-') &&
  !cfg.SUPABASE_ANON_KEY.includes('YOUR-');

if (!configured) {
  const show = () => {
    document.body.innerHTML =
      '<div style="max-width:640px;margin:12vh auto;padding:24px;line-height:1.55;' +
      'font-family:system-ui,-apple-system,sans-serif;color:#333">' +
      '<h2 style="margin-top:0">Supabase config missing</h2>' +
      '<p>Copy <code>js/config.example.js</code> to <code>js/config.js</code> and fill in your ' +
      'project&rsquo;s <strong>URL</strong> and <strong>anon key</strong> ' +
      '(Supabase dashboard &rarr; Project Settings &rarr; API).</p>' +
      '<p>See <code>SETUP.md</code> for the full walkthrough.</p></div>';
  };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  throw new Error('Missing or placeholder Supabase config in js/config.js');
}

export const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // true so password-recovery links from reset emails are picked up on load
    detectSessionInUrl: true
  }
});
