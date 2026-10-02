import type { Provider } from "@earendil-works/pi-ai";
import type { JudgeErrorKind } from "../judge.ts";
import type { Decision, ObservationUsage } from "../utils.ts";
/** What print, steer and interrupt do here; heads are told this instead of pi's behaviour. */
export declare const FLUE_DELIVERY_GUIDANCE = "\"print\" writes a note to the conversation log for the people watching; the main assistant will not see it. Use \"steer\" when the main assistant needs the feedback: it reads it before its answer is final and keeps working. \"interrupt\" is delivered the same way as \"steer\" here.";
export interface FlueHydraOptions {
    /** Paths to pi-hydra head files. Heads must be judges (`tools: []`). */
    heads: string[];
    /** Most `pi-hydra` signals appended to one response; later findings are logged as unresolved. Default 3. */
    maxRounds?: number;
    /** Called once per head check. */
    onRecord?: (record: HydraRecord) => void;
}
export interface HydraRecord {
    conversationId: string;
    head: string;
    /** Which append round of the response this check belongs to (0 = the response's first finish). */
    round: number;
    outcome: "findings" | "none" | "failed";
    findings: Decision[];
    errorKind: JudgeErrorKind | "no-capture" | "unsupported-api" | "unexpected-payload" | "exception" | null;
    error: string | null;
    usage: ObservationUsage | null;
    durationMs: number;
}
export interface FlueHydra {
    /** The same provider, recording each main-conversation request so heads can replay it. */
    wrap(provider: Provider): Provider;
    /** Call inside the agent function: reviews each response before it settles. */
    useHydra(): void;
    /** Removes Hydra's Flue instrumentation and closes the provider sessions it kept open. Call at shutdown. */
    close(): Promise<void>;
}
export declare function createFlueHydra(options: FlueHydraOptions): FlueHydra;
