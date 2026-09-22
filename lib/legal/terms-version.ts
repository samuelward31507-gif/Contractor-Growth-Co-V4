/**
 * The single current version of the Terms of Service / Privacy Policy a
 * signup is recorded against. Bump this (a plain date string, not semver)
 * whenever either document's substance changes - organizations.terms_version
 * exists specifically so a future re-consent flow can compare a stored value
 * against this constant, without needing to diff document text.
 */
export const TERMS_VERSION = "2026-09-21";
