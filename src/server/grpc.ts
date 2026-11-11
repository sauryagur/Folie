// Shared plumbing for the dynamically loaded gRPC clients (ax, Substrate).
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { join } from "node:path";
import { traceHeaders } from "../shared/trace";

/** Directory holding the vendored .proto files; overridable because compiled binaries have no source tree. */
export const defaultProtoDir = () =>
  process.env.FOLIE_PROTO_DIR ?? join(import.meta.dirname, "../../proto");

/**
 * A vendored proto: `root` is its import root under the proto dir, `file` its upstream path below that root,
 * so the upstream `import "pkg/apis/…"` lines resolve unchanged.
 */
export interface ProtoSource {
  root: string;
  file: string;
}

/** ax (google/ax), split per resource upstream; the entry file imports the rest. */
export const AX_PROTO: ProtoSource = {
  root: "ax",
  file: "pkg/apis/v1alpha1/ax.proto",
};

/** Agent Substrate's control API (package substrate.ateapi.v1 since Substrate v1.0.0). */
export const SUBSTRATE_PROTO: ProtoSource = {
  root: "substrate",
  file: "api/ateapi/v1/ateapi.proto",
};

/** Loads `<pkg path>` from a vendored proto and returns its service constructor. */
export function loadService(
  source: ProtoSource,
  servicePath: string[],
  protoDir = defaultProtoDir(),
): grpc.ServiceClientConstructor {
  const def = protoLoader.loadSync(source.file, {
    includeDirs: [join(protoDir, source.root)],
    keepCase: false,
    longs: String,
    defaults: true,
    oneofs: true,
  });
  let node: unknown = grpc.loadPackageDefinition(def);
  for (const part of servicePath) {
    node = (node as Record<string, unknown> | undefined)?.[part];
    if (node === undefined)
      throw new Error(
        `${source.root}/${source.file} has no service ${servicePath.join(".")}`,
      );
  }
  return node as grpc.ServiceClientConstructor;
}

type Unary<Req, Res> = (
  req: Req,
  md: grpc.Metadata,
  cb: (err: grpc.ServiceError | null, res: Res) => void,
) => void;

/**
 * Calls a unary method by name. grpc-js client methods rely on `this`, so they must be invoked on the client.
 * Req/Res are the caller's statement of the wire shape; the loader gives no static types.
 * The active span's W3C trace context travels as gRPC metadata, so ax and Substrate calls sit inside the caller's trace.
 */
export function callUnary<Res, Req = unknown>(
  client: grpc.Client,
  method: string,
  req: Req,
): Promise<Res> {
  const { promise, resolve, reject } = Promise.withResolvers<Res>();
  const fn = (client as unknown as Record<string, Unary<Req, Res>>)[method];
  if (!fn) throw new Error(`gRPC client has no method ${method}`);
  const md = new grpc.Metadata();
  for (const [k, v] of Object.entries(traceHeaders())) md.set(k, v);
  fn.call(client, req, md, (err, res) => (err ? reject(err) : resolve(res)));
  return promise;
}

export const isGrpcStatus = (e: unknown, code: grpc.status) =>
  (e as grpc.ServiceError | undefined)?.code === code;
