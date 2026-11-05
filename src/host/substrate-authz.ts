// Lets folie-server's ServiceAccount call the Substrate API (egress policies) by adding it to
// ate-api-server's bootstrap owners. This is a Substrate install setting, not a change to ax.
// Owner is global: a narrower atespace-editor access policy is the upgrade once Folie owns that bootstrap.
import { NS, capture, kubectl, must } from "./env";

const FLAG = "--authz-bootstrap-owners=";
export const FOLIE_SERVER_PRINCIPAL = `system:serviceaccount:${NS}:folie-server`;

/** Returns the flag with `owner` appended, or null when it is already listed. */
export function withBootstrapOwner(arg: string, owner: string): string | null {
  if (!arg.startsWith(FLAG)) throw new Error(`not an ${FLAG} argument: ${arg}`);
  const owners = arg.slice(FLAG.length).split(",").filter(Boolean);
  return owners.includes(owner) ? null : FLAG + [...owners, owner].join(",");
}

interface Deployment {
  spec: { template: { spec: { containers: { args?: string[] }[] } } };
}

export async function grantFolieServerSubstrateAccess(): Promise<void> {
  const d = JSON.parse(
    await capture(
      kubectl(
        "-n",
        "ate-system",
        "get",
        "deployment",
        "ate-api-server",
        "-o",
        "json",
      ),
    ),
  ) as Deployment;
  const containers = d.spec.template.spec.containers;
  const ci = containers.findIndex((c) =>
    c.args?.some((a) => a.startsWith(FLAG)),
  );
  if (ci < 0)
    throw new Error(
      "ate-api-server has no --authz-bootstrap-owners argument; cannot grant folie-server access",
    );
  const args = containers[ci]!.args!;
  const ai = args.findIndex((a) => a.startsWith(FLAG));
  const next = withBootstrapOwner(args[ai]!, FOLIE_SERVER_PRINCIPAL);
  if (next === null) return;

  console.log(
    `==> granting ${FOLIE_SERVER_PRINCIPAL} access to the Substrate API`,
  );
  const patch = JSON.stringify([
    {
      op: "replace",
      path: `/spec/template/spec/containers/${ci}/args/${ai}`,
      value: next,
    },
  ]);
  await must(
    kubectl(
      "-n",
      "ate-system",
      "patch",
      "deployment",
      "ate-api-server",
      "--type=json",
      "-p",
      patch,
    ),
  );
  await must(
    kubectl(
      "-n",
      "ate-system",
      "rollout",
      "status",
      "deployment/ate-api-server",
      "--timeout=180s",
    ),
  );
}
