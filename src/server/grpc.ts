// Shared plumbing for the dynamically loaded gRPC clients (ax, Substrate).
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { join } from "node:path";
import { traceHeaders } from "../shared/trace";

/** Directory holding the vendored .proto files; overridable because compiled binaries have no source tree. */
export const defaultProtoDir = () =>
  process.env.FOLIE_PROTO_DIR ?? join(import.meta.dirname, "../../proto");

/** Loads `<pkg path>` from a vendored proto and returns its service constructor. */
export function loadService(
  protoFile: string,
  servicePath: string[],
  protoDir = defaultProtoDir(),
): grpc.ServiceClientConstructor {
  const def = protoLoader.loadSync(join(protoDir, protoFile), {
    keepCase: false,
    longs: String,
    defaults: true,
    oneofs: true,
  });
  let node: unknown = grpc.loadPackageDefinition(def);
  for (const part of servicePath)
    node = (node as Record<string, unknown>)[part];
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
