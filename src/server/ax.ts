// Port to ax plus its gRPC adapter. Folie only ever consumes ax's API; it never patches ax.
import * as grpc from "@grpc/grpc-js";
import { callUnary, isGrpcStatus, loadService } from "./grpc";

export interface AxTaskSpec {
  atespace: string;
  name: string;
  image: string;
  command: string[];
  env: Record<string, string>;
}

export interface AxTaskInfo {
  phase: string;
  /** The Substrate actor behind the task (egress policies attach to it). */
  actor: string;
}

export interface AxClient {
  /** null when the task does not exist. */
  getTask(atespace: string, name: string): Promise<AxTaskInfo | null>;
  createTask(spec: AxTaskSpec): Promise<void>;
  resumeTask(atespace: string, name: string): Promise<void>;
  /** Checkpoints /workspace and frees the worker. The agent's memory survives. */
  suspendTask(atespace: string, name: string): Promise<void>;
  /** Destroys the task and its /workspace: the agent's memory with it. */
  deleteTask(atespace: string, name: string): Promise<void>;
}

interface TaskKey {
  atespace: string;
  name: string;
}

export function grpcAxClient(address: string, protoDir?: string): AxClient {
  const AX = loadService("ax.proto", ["ax", "v1alpha1", "AX"], protoDir);
  const c = new AX(address, grpc.credentials.createInsecure());
  const byKey = (method: string) => (atespace: string, name: string) => callUnary<unknown, TaskKey>(c, method, { atespace, name }).then(() => {});

  return {
    async getTask(atespace, name) {
      try {
        const t = await callUnary<{ status?: { phase?: string; actor?: string } }, TaskKey>(c, "GetTask", { atespace, name });
        return { phase: t.status?.phase ?? "", actor: t.status?.actor || name };
      } catch (e) {
        if (isGrpcStatus(e, grpc.status.NOT_FOUND)) return null;
        throw e;
      }
    },
    async createTask({ atespace, name, image, command, env }) {
      await callUnary(c, "CreateTask", {
        task: {
          apiVersion: "ax.io/v1alpha1",
          kind: "Task",
          metadata: { name, atespace },
          spec: { image, command, env: Object.entries(env).map(([name, value]) => ({ name, value })) },
        },
      });
    },
    resumeTask: byKey("ResumeTask"),
    suspendTask: byKey("SuspendTask"),
    deleteTask: byKey("DeleteTask"),
  };
}
