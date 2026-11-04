// Operator steering of a single agent. The HTTP layer depends on this port, the controller implements it.
import type { AgentOp, AgentOpResult } from "../shared/types";

export interface AgentOps {
  /**
   * suspend: checkpoint a running agent. resume: bring an agent up now (creating its task if needed).
   * delete: destroy the task and its /workspace at once, whatever the agent is doing: the kill switch.
   */
  run(op: AgentOp, agent: string): Promise<AgentOpResult>;
}
