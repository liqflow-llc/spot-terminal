// Shared constants for the Terms and the Privacy Policy, so the two can never disagree
// about who runs the site. Same convention as LiqFlow (liq-heatmap/frontend/src/pages/legalMeta.js).
//
// LiqFlow LLC was filed with Florida on 2 October 2026 and is pending approval. Once Sunbiz
// shows it as Active, change these two lines to:
//   OPERATOR      = 'LiqFlow LLC, a Florida limited liability company'
//   OPERATOR_KIND = 'a one-person company'
// Not before: naming a company that does not exist yet is worse than naming none.
//
// The documents use the first person singular ("I", "me"), as LiqFlow's do.
export const OPERATOR = 'Phil, an individual based in Florida, USA';
export const OPERATOR_KIND = 'one person, not a company';
export const CONTACT_EMAIL = 'support@liqflow.app';
export const LEGAL_UPDATED = '5 October 2026';
// Matches nginx's logrotate setting for this site (daily, 14 kept).
export const ACCESS_LOG_DAYS = 14;
