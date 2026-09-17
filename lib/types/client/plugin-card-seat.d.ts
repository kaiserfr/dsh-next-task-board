/**
 * Family plugin-card seat.
 *
 * A family plugin contributes its settings card to whichever plugin-card seat
 * the running host actually renders:
 *
 * - `web-ui.plugin.item` — the list seat declared by the dsh-web-settings
 *   group section (this family's own first-level "Web UI plugins" section);
 * - `settings.plugin.item` — the official keyed seat of the harness's
 *   `ui-settings-plugins` tab, keyed by the settings namespace the card edits.
 *
 * SEAT SELECTION IS NOT A DECLARATION PROBE. The official `ui-settings-plugins`
 * row belongs to the harness bundle and its `configurable` tab always declares
 * `settings.plugin.item` before any external plugin's `apply()` runs, so
 * "is the official seat declared?" answers yes even in the deployment whose
 * whole point is the family group. Choosing on that probe sends every family
 * card to the official Plugins tab and leaves the group's own section
 * permanently empty — the family of reports where the section renders its
 * heading and zero cards.
 *
 * The signal that actually distinguishes the two deployments is whether
 * dsh-web-settings is loaded: it is the package that owns the group section and
 * it publishes the `webUiSettings` service during `apply()`, which every
 * family plugin already reads for its settings scope. Group loaded -> the family
 * seat; group absent -> the official seat.
 *
 * The decision is re-evaluated on every `slots/changed` because the group may
 * apply after this plugin (the family aggregate orders it first, a profile that
 * installs the group separately need not): the initial contribution goes to the
 * official seat, then moves to the family seat the moment the group's section
 * registers. The entry is disposed before the replacement is registered, so a
 * card is never in two seats at once.
 *
 * The shared tree has no client-SDK dependency, so this module reads its
 * context through the structural shape below; callers pass the plugin's own
 * `ctx`.
 */
/** The family list seat key. */
export declare const FAMILY_PLUGIN_CARD_SEAT = "web-ui.plugin.item";
/** The official keyed plugin-card seat key. */
export declare const OFFICIAL_PLUGIN_CARD_SEAT = "settings.plugin.item";
/** The service dsh-web-settings publishes while it is loaded. */
export declare const FAMILY_GROUP_SERVICE = "webUiSettings";
/** The slot-registry member this helper uses (structurally satisfied by ctx.slots). */
export interface PluginCardSlots {
    /** Contribution of one card entry. */
    register(options: never, component: never): unknown;
}
/** The slice of the client context a card contribution needs. */
export interface PluginCardContext {
    slots: PluginCardSlots;
    /** Service lookup; absent on a context double that only models the slots. */
    get?(name: string): unknown;
    /** Event subscription seat; absent on an event-less test double. */
    on?(event: string, listener: (...args: never[]) => void): unknown;
}
/** Owner share of a plugin card (both seats supply nothing). */
export interface SettingsPluginItemOwnerProps {
    /** Marker field: card owner props are intentionally empty. */
    children?: never;
}
/** One family plugin's card contribution. */
export interface PluginCardSeat {
    /** Settings namespace the card edits (the official seat's dispatch key). */
    namespace: string;
    /** Family list-seat entry id. */
    id: string;
    /** Family list-seat sort order. */
    order?: number;
    /** Family list-seat display label; the official keyed seat carries none. */
    label?: () => string;
    /** Locale namespace the card renders with. */
    locale: string;
    /** Business-face factory of the registration. */
    inject?: () => object;
    /**
     * The card component. Its props type is the seat's composed shape, which is
     * chosen at runtime, so the helper takes it erased; the registrant keeps its
     * own precise typing at the call site.
     */
    component: unknown;
}
/**
 * Whether the family group (dsh-web-settings) is loaded in this page. The
 * service is the group package's own contract, so the probe cannot be fooled
 * by a harness release that starts declaring the official seat differently.
 */
export declare function familyGroupLoaded(ctx: PluginCardContext): boolean;
/**
 * Contribute one family plugin card to the seat this host renders, following
 * the group if it loads later. The entry is disposed and re-registered on a
 * seat change, never duplicated.
 * @param ctx - client context (its slot registry decides the seat).
 * @param seat - the card contribution.
 */
export declare function installPluginCard(ctx: PluginCardContext, seat: PluginCardSeat): void;
