/**
 * Session deep link: the card's session jump is an anchor, so its target must
 * be expressible as a URL. The Web shell has no router of its own, so the
 * board claims the `#session=<id>` hash — a plain left-click is handled in
 * place (the anchor's onClick), while middle-click / Ctrl-click / a copied URL
 * boots a fresh page that opens the session from the hash. One format, shared
 * by the anchor that writes it and the boot listener that reads it.
 */
/** Hash target of one session: `#session=<id>`. */
export declare function sessionLinkHref(sessionId: string): string;
/**
 * Session id carried by a `location.hash`, or undefined when it is not a
 * session link (no hash, another fragment, or a blank id).
 */
export declare function sessionLinkTarget(hash: string): string | undefined;
