// Shared constants for the Terms and the Privacy Policy, so the two can never disagree
// about who runs the site. Same convention as LiqFlow (liq-heatmap/frontend/src/pages/legalMeta.js).
//
// The site is operated by LiqFlow LLC (filed with Florida on 2 October 2026), at the owner's request.
// The documents use the first person singular ("I", "me"), as LiqFlow's do.
export const OPERATOR = 'LiqFlow LLC, a Florida limited liability company';
export const OPERATOR_KIND = 'a one-person company';
export const CONTACT_EMAIL = 'support@liqflow.app';
export const LEGAL_UPDATED = '6 October 2026';
// Matches nginx's logrotate setting for this site (daily, 14 kept).
export const ACCESS_LOG_DAYS = 14;
