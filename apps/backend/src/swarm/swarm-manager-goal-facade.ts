import { EventEmitter } from "node:events";
import type {
  SessionGoalControlAction,
  SessionGoalSnapshot,
  SessionGoalSnapshotEvent,
} from "@forge/protocol";
import type { CreateGoalInput, UpdateGoalInput } from "./goals/goal-tools.js";
import type { SwarmManagerFacadeServices } from "./swarm-manager-facade-services.js";

/** Stable public delegates for the durable session-goal surface. */
export abstract class SwarmManagerGoalFacade extends EventEmitter {
  protected abstract getFacadeServices(): SwarmManagerFacadeServices;

  createGoal(
    callerAgentId: string,
    toolCallId: string,
    input: CreateGoalInput,
  ): Promise<SessionGoalSnapshot> {
    return this.getFacadeServices().goals.create(callerAgentId, toolCallId, input);
  }

  getGoal(callerAgentId: string): Promise<SessionGoalSnapshot> {
    return this.getFacadeServices().goals.get(callerAgentId);
  }

  updateGoal(
    callerAgentId: string,
    toolCallId: string,
    input: UpdateGoalInput,
  ): Promise<SessionGoalSnapshot> {
    return this.getFacadeServices().goals.update(callerAgentId, toolCallId, input);
  }

  getSessionGoalSnapshot(sessionAgentId: string): Promise<SessionGoalSnapshotEvent> {
    return this.getFacadeServices().goals.getSnapshotEvent(sessionAgentId);
  }

  controlSessionGoal(
    sessionAgentId: string,
    action: SessionGoalControlAction,
  ): Promise<SessionGoalSnapshot> {
    return this.getFacadeServices().goals.control(sessionAgentId, action);
  }
}
