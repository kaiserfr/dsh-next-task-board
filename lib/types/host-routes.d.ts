import type { IncomingMessage } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { TaskBoardHostService } from './host-service.ts';
import { type TaskBoardParseDraft, type TaskBoardParseRequest } from './protocol.ts';
/** Header replaced by an authenticated same-host reverse proxy. */
export declare const TASK_BOARD_PROXY_TOKEN_HEADER = "x-dsh-task-board-proxy-token";
/** Optional authenticated reverse-proxy access layered over the loopback default. */
export interface TaskBoardRouteAccess {
    trustedProxyHosts?: readonly string[];
    proxyToken?: string;
    /**
     * Whether the deployment's own Connection service accepts this request:
     * its Host/Origin fence plus a valid browser credential. Supplied by the
     * plugin entry (`ctx.connection.requestRejection`), so a LAN client clears
     * exactly the trust bar of every other dsh API — needed since dsh 0.2.1
     * refuses the wildcard bind and a profile that must stay reachable on the
     * LAN serves no loopback socket for the browser to use.
     */
    hostCredential?: (request: IncomingMessage) => boolean;
}
/**
 * Host faces the routes need beyond the ledger service. The parse face is
 * resolved lazily by the caller, so a deployment without an llm service still
 * registers the route and answers with a typed "no model" failure instead of
 * leaving the panel with an unmounted path (issue #1540).
 */
export interface TaskBoardRouteOptions {
    parseTask?: (request: TaskBoardParseRequest, signal: AbortSignal) => Promise<TaskBoardParseDraft>;
}
interface ResolvedRouteAccess {
    trustedProxyHosts: ReadonlySet<string>;
    proxyToken?: string;
    hostCredential?: (request: IncomingMessage) => boolean;
}
/**
 * Task-board route fence. Direct desktop access uses the repository-wide
 * loopback socket + Host guard and additionally requires a browser same-origin
 * marker: a bare local curl without any browser signal cannot exercise the
 * agent control plane (a forged Origin does pass the marker — it is a
 * tripwire, the socket/Host/origin-equality checks carry the authority).
 * A deployment that cannot serve loopback at all — dsh 0.2.1 rejects the
 * wildcard bind, so a LAN-reachable profile binds one concrete address —
 * supplies `hostCredential`, the Connection service's own admission decision:
 * the request then needs the same Host/Origin fence and browser credential as
 * every other dsh API instead of a loopback socket. Authenticated proxies must
 * be explicitly allowlisted and replace the internal token header after their
 * own authentication step.
 */
export declare function isTrustedTaskBoardRequest(req: IncomingMessage, access: ResolvedRouteAccess): boolean;
export declare function makeTaskBoardRoutes(service: TaskBoardHostService, access?: TaskBoardRouteAccess, options?: TaskBoardRouteOptions): WebRoute[];
export {};
