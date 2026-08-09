// ---------------------------------------------------------------------------
// Copy this file to `config.js` (which is gitignored) and fill in the two
// values from your Supabase project:  Dashboard -> Project Settings -> API.
//
// The anon / "public" key is DESIGNED to be exposed in the browser — Row Level
// Security is what actually protects the data. NEVER put the service_role
// ("secret") key in here or anywhere in the front-end.
// ---------------------------------------------------------------------------
window.PORTAL_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-PUBLIC-ANON-KEY'
};
