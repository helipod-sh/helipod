import type { DeployTarget, DeployResult } from "../types";
import { DeployError } from "../types";

/**
 * AWS provision target.
 *
 * v1 assumption: an AWS App Runner service already exists (provisioned out-of-band — console,
 * Terraform, CDK — the same posture as `railwayTarget` assuming a linked Railway service, or
 * `cloudflareTarget` assuming a `wrangler.jsonc`), configured to pull from an ECR repo that a
 * separate CI/build step pushes images to (out of scope here, same as `railwayTarget`'s note that
 * a project deploying to Railway is expected to already have a working Dockerfile). This adapter's
 * `push` triggers App Runner to roll out a fresh deployment of whatever image is currently
 * configured on the service, via `aws apprunner start-deployment --service-arn <arn>`.
 *
 * App Runner was chosen over raw ECS/Fargate because it is AWS's simplest fully-managed
 * "point at a container image, get a URL" service — the closest AWS analog to Railway/Fly's deploy
 * model, so the same single-CLI-command push shape applies with no separate task-definition/
 * service/target-group orchestration to reimplement here.
 */
export const awsTarget: DeployTarget = {
  name: "aws",
  async preflight(ctx) {
    const v = await ctx.spawn.run("aws", ["--version"], { cwd: ctx.cwd, stdio: "capture" }).catch(() => {
      throw new DeployError("aws CLI not found — install the AWS CLI (https://docs.aws.amazon.com/cli/) and retry");
    });
    if (v.code !== 0) throw new DeployError("aws CLI not found — install the AWS CLI and retry");
    const serviceArn = ctx.target.settings.serviceArn == null ? undefined : String(ctx.target.settings.serviceArn);
    if (!serviceArn) {
      throw new DeployError("aws target needs a serviceArn — set deploy.targets.<name> settings.serviceArn to the App Runner service ARN");
    }
    // AWS_ACCESS_KEY_ID (or an assumed profile via AWS_PROFILE) is the documented non-interactive
    // credential path — required in CI since the aws CLI otherwise falls back to interactive SSO
    // login / device-code prompts.
    if (!ctx.interactive && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
      throw new DeployError("AWS_ACCESS_KEY_ID (or AWS_PROFILE) is required for non-interactive (CI) deploy");
    }
  },
  async package(ctx) {
    // App Runner deploys the image already configured on the service (an ECR repo pushed to by a
    // separate CI step — see the file's doc comment) — there is nothing to bundle here beyond
    // refreshing codegen so the baked functions directory's `_generated` matches the functions
    // being deployed.
    await ctx.codegen();
  },
  async push(ctx): Promise<DeployResult> {
    const serviceArn = String(ctx.target.settings.serviceArn ?? "");
    const args = ["apprunner", "start-deployment", "--service-arn", serviceArn];
    const region = ctx.target.settings.region == null ? undefined : String(ctx.target.settings.region);
    if (region) args.push("--region", region);
    const r = await ctx.spawn.run("aws", args, { cwd: ctx.cwd, stdio: "capture" });
    if (r.code !== 0) return { ok: false, error: `aws apprunner start-deployment failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}` };
    return { ok: true, detail: (r.stdout || "deployment started (aws apprunner start-deployment)").trim() };
  },
};
