/**
 * The Console commands shown on the connect screen.
 *
 * They live here as plain string constants, not as JSX text, so nothing in
 * the toolchain or the editor can turn the straight double quotes into
 * typographic ones: a curly quote is a syntax error in the Console. A test
 * guards that.
 */

export const PLAUD_WEB_URL = "https://web.plaud.ai";

/** Copies the whole session (all four values) in one go. */
export const COPY_SESSION_COMMAND =
    'copy(localStorage.getItem("pld_session.tokens"))';

/** Fallback: the bearer token on its own. */
export const COPY_BEARER_COMMAND =
    'copy("Bearer " + Object.values(JSON.parse(localStorage.getItem("pld_session.tokens")).byWsId)[0].token)';

/** Fallback: the refresh token on its own. */
export const COPY_REFRESH_COMMAND =
    'copy(Object.values(JSON.parse(localStorage.getItem("pld_session.tokens")).byWsId)[0].refreshToken)';
