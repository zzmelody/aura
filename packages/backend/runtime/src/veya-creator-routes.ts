import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FlowCatalog, FlowRun } from "@aura/protocol/types";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { creatorArtifact } from "./veya-creator-artifacts.ts";
import { admitVeyaCraft, readVeyaCraftScope, verifyCraftForeground, type VeyaCraftScope } from "@aura/orchestration";
import { retainedPropWork, type PropRecovery } from "./veya-creator-recovery.ts";
import { retainedWorldDesign, type WorldDesignRecovery } from "./veya-creator-world-design-recovery.ts";
import { inheritedDesignAssets, retainedCommonAssets } from "./veya-creator-asset-reuse.ts";
import { hasWorldProductionResume, retainedWorldProduction } from "./veya-creator-world-production-recovery.ts";
import { retainedProductionMaterials } from "./veya-creator-production-materials.ts";
import { readMaterialsGrant, writeMaterialsGrant, validateMaterialsBinding, type MaterialsGrant } from "@aura/orchestration";
import { readCreatorBindingDocument, commitCreatorBindingDocument } from "@aura/orchestration";
import { readProductionGrant, writeProductionGrant, validateProductionBinding, validatePendingProductionClaims, productionRecoveryBoundary, type ProductionGrantRef, type ProductionGrant } from "@aura/orchestration";
import { readAssetReuseGrant, validateInheritedAssetReuseBinding, readCreatorLeases, type AssetReuseGrant, type OrchestrationHost } from "@aura/orchestration";

type FlowPort = Pick<OrchestrationHost, "request">;
type Kind = "prop" | "world";
type Operation = "create_world" | "create_prop" | "update_layout" | "update_environment";
type TargetGrant = { worldId: string; baseRevision: number; baseHash?: string; allowedEntityIds: string[]; allowSpawnChange: boolean };
type ArtifactTarget = Pick<TargetGrant, "allowedEntityIds" | "allowSpawnChange">;
type PreviousArtifact = { artifactId: string; candidateHash: string; kind: "world" | "prop" | "patch" };
type CreationInput = { operation: Operation; text: string; craft?: VeyaCraftScope; targetWorldId?: string; target?: TargetGrant;
  references?: string[]; previousArtifactId?: string; artifactTarget?: ArtifactTarget; previousRequestId?: string; reuseAssetsFromRequestId?: string; reuseProductionFromRequestId?: string };
const operations = ["create_world", "create_prop", "update_layout", "update_environment"];
function creationInput(body: Record<string, unknown>): CreationInput {
  if (Object.keys(body).some(key => !["requestId", "kind", "operation", "text", "targetWorldId", "target", "references",
      "previousArtifactId", "artifactTarget", "previousRequestId", "reuseAssetsFromRequestId", "reuseProductionFromRequestId", "craft"].includes(key))) throw new Error("invalid_request");
  const operation = body.operation ?? (body.kind === "prop" ? "create_prop" : body.kind === "world" ? "create_world" : undefined);
  if (typeof operation !== "string" || !operations.includes(operation) || typeof body.text !== "string" ||
      body.text.trim().length < 2 || body.text.length > 4000 ||
      (body.targetWorldId !== undefined && (typeof body.targetWorldId !== "string" || !stableId.test(body.targetWorldId))) ||
      (operation.startsWith("update_") && typeof body.targetWorldId !== "string" && !object(body.target) && !object(body.artifactTarget)) ||
      (body.references !== undefined && (!Array.isArray(body.references) || body.references.length > 8 ||
        !body.references.every(value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)))) ||
      (body.previousArtifactId !== undefined && (typeof body.previousArtifactId !== "string" || !/^[a-f0-9]{64}$/u.test(body.previousArtifactId))))
    throw new Error("invalid_request");
  if (body.kind !== undefined && body.kind !== (operation === "create_prop" ? "prop" : "world")) throw new Error("invalid_request");
  if (body.reuseProductionFromRequestId !== undefined && (typeof body.reuseProductionFromRequestId !== "string" || !uuid.test(body.reuseProductionFromRequestId) ||
      operation !== "create_world" || ["previousRequestId", "previousArtifactId", "reuseAssetsFromRequestId", "target", "targetWorldId", "artifactTarget", "references"].some(k => body[k] !== undefined)))
    throw new Error("invalid_request");
  if (body.reuseAssetsFromRequestId !== undefined && (typeof body.reuseAssetsFromRequestId !== "string" || !uuid.test(body.reuseAssetsFromRequestId) ||
      operation !== "create_world" || ["previousRequestId", "previousArtifactId", "target", "targetWorldId", "artifactTarget", "references"].some(k => body[k] !== undefined)))
    throw new Error("invalid_request");
  if (body.previousRequestId !== undefined && (typeof body.previousRequestId !== "string" || !uuid.test(body.previousRequestId) ||
      !["create_prop", "create_world"].includes(operation) || body.previousArtifactId !== undefined || body.target !== undefined ||
      body.targetWorldId !== undefined || body.artifactTarget !== undefined || body.references !== undefined)) throw new Error("invalid_request");
  if (body.previousArtifactId !== undefined && (body.target !== undefined || body.targetWorldId !== undefined) &&
      (!operation.startsWith("update_") || !object(body.target) || body.artifactTarget !== undefined))
    throw new Error("invalid_request");
  let artifactTarget: ArtifactTarget | undefined;
  if (body.artifactTarget !== undefined) {
    const scope = object(body.artifactTarget);
    if (!operation.startsWith("update_") || typeof body.previousArtifactId !== "string" || !scope || body.target !== undefined ||
        !Array.isArray(scope.allowedEntityIds) || scope.allowedEntityIds.length > 512 ||
        !scope.allowedEntityIds.every(value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(value)) ||
        new Set(scope.allowedEntityIds).size !== scope.allowedEntityIds.length || typeof scope.allowSpawnChange !== "boolean")
      throw new Error("invalid_request");
    artifactTarget = { allowedEntityIds: [...scope.allowedEntityIds as string[]].sort(), allowSpawnChange: scope.allowSpawnChange };
  }
  let target: TargetGrant | undefined;
  if (body.target !== undefined) {
    const source = object(body.target);
    if (!operation.startsWith("update_") || !source || typeof source.worldId !== "string" || !stableId.test(source.worldId) ||
        (body.targetWorldId !== undefined && body.targetWorldId !== source.worldId) ||
        !Number.isSafeInteger(source.baseRevision) || (source.baseRevision as number) < 0 ||
        (source.baseHash !== undefined && (typeof source.baseHash !== "string" || !/^[a-f0-9]{64}$/u.test(source.baseHash))) ||
        !Array.isArray(source.allowedEntityIds) || source.allowedEntityIds.length > 512 ||
        !source.allowedEntityIds.every(value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(value)) ||
        new Set(source.allowedEntityIds).size !== source.allowedEntityIds.length || typeof source.allowSpawnChange !== "boolean")
      throw new Error("invalid_request");
    target = { worldId: source.worldId, baseRevision: source.baseRevision as number,
      ...(typeof source.baseHash === "string" ? { baseHash: source.baseHash } : {}),
      allowedEntityIds: [...source.allowedEntityIds as string[]].sort(), allowSpawnChange: source.allowSpawnChange };
    // Existing progress is retained only in an explicit owned checkout target.
    // Native world.read must attest its artifact lineage before any production.
    if (body.previousArtifactId !== undefined && (!target.baseHash || target.baseRevision < 1)) throw new Error("invalid_request");
  }
  const craft = body.craft === undefined ? undefined : readVeyaCraftScope(body.craft);
  if (craft && (operation !== "create_prop" || ["targetWorldId", "target", "references", "previousArtifactId", "artifactTarget", "previousRequestId", "reuseAssetsFromRequestId", "reuseProductionFromRequestId"].some(k => body[k] !== undefined))) throw new Error("invalid_request");
  return { operation: operation as Operation, text: body.text, ...(craft ? { craft } : {}),
    ...(typeof body.reuseProductionFromRequestId === "string" ? { reuseProductionFromRequestId: body.reuseProductionFromRequestId } : {}),
    ...(typeof body.reuseAssetsFromRequestId === "string" ? { reuseAssetsFromRequestId: body.reuseAssetsFromRequestId } : {}),
    ...(typeof body.previousRequestId === "string" ? { previousRequestId: body.previousRequestId } : {}),
    ...(artifactTarget ? { artifactTarget } : {}),
    ...(target ? { target } : {}),
    ...(target ? { targetWorldId: target.worldId } : typeof body.targetWorldId === "string" ? { targetWorldId: body.targetWorldId } : {}),
    ...(Array.isArray(body.references) ? { references: body.references as string[] } : {}),
    ...(typeof body.previousArtifactId === "string" ? { previousArtifactId: body.previousArtifactId } : {}) };
}
type Binding = {
  craftAuthorization?: VeyaCraftScope;
  craftOriginalAuthorization?: VeyaCraftScope;
  craftAuthorizationDigest?: string;
  foregroundSessionPath?: string;
  playerId: string;
  homeWorldId: string;
  kind: Kind;
  textHash: string;
  requestHash?: string;
  input?: CreationInput;
  previousArtifact?: PreviousArtifact;
  recovery?: PropRecovery;
  worldDesignRecovery?: WorldDesignRecovery;
  worldProductionRecoveryRef?: ProductionGrantRef;
  productionRecoveryClaimVersion?: 1;
  productionRecoveryClaim?: string;
  productionMaterialsRef?: ProductionGrantRef;
  assetReuse?: AssetReuseGrant;
  recoveryBudgetCreationId?: string;
  answers?: Record<string, { fingerprint: string; accepted: boolean; checkpointRunId: string; stepKey: string }>;
  sessionPath: string;
  creationSessionId?: string;
  runId?: string;
};
type BindingFile = { version: 1; bindings: Record<string, Binding> };
type Client = { playerId: string; homeWorldId: string; sessionPath: string; foregroundSessionPath?: string; creationSessionId: string; token: string };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const stableId = /^[A-Za-z0-9_-]{1,96}$/u;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const safe = (left: string, right: string) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

async function boundedObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try { return object(await request.json()); } catch { return undefined; }
}

/** Persistent request ownership and worker binding. Aura Run remains step authority. */
export class VeyaCreatorService {
  readonly directory: string;
  readonly bootstrapToken: string;
  readonly flow: FlowPort;
  readonly projectRoot: string;
  readonly clients = new Map<string, Client>();
  private state: BindingFile = { version: 1, bindings: {} };
  private writes: Promise<void> = Promise.resolve();

  constructor(projectRoot: string, flow: FlowPort, bootstrapToken = randomBytes(32).toString("hex")) {
    this.directory = join(projectRoot, ".aura", "veya-creator");
    this.projectRoot = projectRoot;
    this.flow = flow;
    this.bootstrapToken = bootstrapToken;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      const bytes = await readFile(join(this.directory, "bindings.json"));
      if (bytes.length > 256 * 1024) throw new Error("creator binding file too large");
      const value = await readCreatorBindingDocument(this.projectRoot, bytes) as unknown as BindingFile;
      if (value?.version !== 1 || !object(value.bindings)) throw new Error("invalid creator bindings");
      for (const [key, item] of Object.entries(value.bindings))
        if (!uuid.test(key) || !stableId.test(item.playerId) || !stableId.test(item.homeWorldId) ||
            !["prop", "world"].includes(item.kind) || !/^[a-f0-9]{64}$/u.test(item.textHash) ||
            !isAbsolute(item.sessionPath) || (item.runId && !uuid.test(item.runId)) ||
            (item.requestHash !== undefined && (!/^[a-f0-9]{64}$/u.test(item.requestHash) || !item.input ||
              sha(JSON.stringify(creationInput(item.input as unknown as Record<string, unknown>))) !== item.requestHash)))
          throw new Error("invalid creator binding");
      for (const item of Object.values(value.bindings)) if (item.assetReuse) {
        const grant = readAssetReuseGrant(item.assetReuse);
        if (item.worldDesignRecovery) { const previous = value.bindings[item.input?.previousRequestId ?? ""];
          validateInheritedAssetReuseBinding(item, previous, value.bindings[previous?.input?.previousRequestId ?? ""]); }
        else if (item.input?.reuseAssetsFromRequestId !== grant.sourceRequestId || item.input.operation !== "create_world" ||
            item.recovery || item.recoveryBudgetCreationId) throw new Error("invalid creator binding");
      }
      for (const item of Object.values(value.bindings)) if (item.worldProductionRecoveryRef)
        validateProductionBinding(await readProductionGrant(this.projectRoot, item.worldProductionRecoveryRef), item,
          value.bindings[item.input?.previousRequestId ?? ""]);
      for (const item of Object.values(value.bindings)) if (item.productionMaterialsRef)
        validateMaterialsBinding(await readMaterialsGrant(this.projectRoot, item.productionMaterialsRef), item,
          value.bindings[item.input?.reuseProductionFromRequestId ?? ""]);
      await validatePendingProductionClaims(this.projectRoot, value.bindings);
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async commit(next: BindingFile) {
    for (const [id, binding] of Object.entries(next.bindings)) {
      const old = this.state.bindings[id];
      if (old?.productionRecoveryClaimVersion === 1 && (binding.productionRecoveryClaimVersion !== 1 ||
          binding.productionRecoveryClaim !== old.productionRecoveryClaim)) throw new Error("production_recovery_claim_invalid");
      if (!old && binding.worldProductionRecoveryRef) {
        const grant = await readProductionGrant(this.projectRoot, binding.worldProductionRecoveryRef);
        if (!grant.proof.pendingRound && binding.productionRecoveryClaimVersion !== 1) throw new Error("production_recovery_claim_invalid");
      }
    }
    await validatePendingProductionClaims(this.projectRoot, next.bindings);
    await commitCreatorBindingDocument(this.projectRoot, next);
    this.state = next;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.writes.then(run);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async register(playerId: string, homeWorldId: string, sessionPath: string, foregroundSessionPath?: string): Promise<string> {
    if (!stableId.test(playerId) || !stableId.test(homeWorldId) || !isAbsolute(sessionPath))
      throw new Error("invalid_client");
    const path = resolve(sessionPath);
    const ownedByOther = (owner: { playerId: string; homeWorldId: string; sessionPath: string }) =>
      owner.sessionPath === path &&
      (owner.playerId !== playerId || owner.homeWorldId !== homeWorldId);
    if ([...this.clients.values(), ...Object.values(this.state.bindings)].some(ownedByOther))
      throw new Error("worker_already_bound");
    const bytes = await readFile(path);
    if (bytes.length > 8192) throw new Error("invalid_worker");
    const descriptor = object(JSON.parse(bytes.toString("utf8")));
    if (descriptor?.role !== "creator-worker" || typeof descriptor.creation_session_id !== "string" ||
        !/^[a-f0-9]{32}$/u.test(descriptor.creation_session_id) || descriptor.protocol !== "veya-world-http/1" ||
        typeof descriptor.base_url !== "string" ||
        !/^http:\/\/127\.0\.0\.1:\d+\/?$/u.test(descriptor.base_url) ||
        typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token))
      throw new Error("invalid_worker");
    if ([...this.clients.values(), ...Object.values(this.state.bindings)].some(owner =>
      owner.creationSessionId === descriptor.creation_session_id &&
      (owner.playerId !== playerId || owner.homeWorldId !== homeWorldId))) throw new Error("worker_already_bound");
    if (foregroundSessionPath !== undefined) await verifyCraftForeground(foregroundSessionPath);
    const token = randomBytes(32).toString("hex");
    this.clients.set(sha(token), { playerId, homeWorldId, sessionPath: path, ...(foregroundSessionPath ? { foregroundSessionPath: resolve(foregroundSessionPath) } : {}), creationSessionId: descriptor.creation_session_id, token });
    return token;
  }

  client(authorization: string | undefined): Client | undefined {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!/^[a-f0-9]{64}$/u.test(token)) return undefined;
    const found = this.clients.get(sha(token));
    return found && safe(token, found.token) ? found : undefined;
  }

  async wishAvailable(): Promise<boolean> {
    const catalog = await this.flow.request<FlowCatalog>("catalog");
    return catalog.flows.some((flow) => flow.id === "veya/veya-wish" &&
      flow.available === true && flow.service === true);
  }

  private async productionRecovery(sourceRequestId: string, depth = 0): Promise<ProductionGrant> {
    const source = this.state.bindings[sourceRequestId];
    if (depth > 3 || !source?.runId || !source.input || source.input.operation !== "create_world") throw new Error("previous_request_unavailable");
    let prior: ProductionGrant | undefined;
    let productionMaterials: MaterialsGrant | undefined;
    if (source.worldProductionRecoveryRef) {
      prior = await readProductionGrant(this.projectRoot, source.worldProductionRecoveryRef);
      const previous = this.state.bindings[source.input.previousRequestId ?? ""];
      validateProductionBinding(prior, source, previous);
      const rebuilt = await this.productionRecovery(prior.recovery.sourceRequestId, depth + 1);
      if (JSON.stringify(rebuilt) !== JSON.stringify(prior)) throw new Error("previous_request_unavailable");
    }
    if (source.assetReuse) {
      const original = this.state.bindings[source.assetReuse.sourceRequestId];
      if (!original || original.runId !== source.assetReuse.sourceRunId || original.input?.text !== source.input.text ||
          ["playerId", "homeWorldId", "creationSessionId", "sessionPath"].some(key => (source as any)[key] !== (original as any)[key]))
        throw new Error("previous_request_unavailable");
    }
    if (source.productionMaterialsRef) {
      if (prior || source.assetReuse || source.worldDesignRecovery || source.recovery) throw new Error("previous_request_unavailable");
      productionMaterials = await readMaterialsGrant(this.projectRoot, source.productionMaterialsRef);
      const producer = this.state.bindings[productionMaterials.materials.sourceRequestId];
      validateMaterialsBinding(productionMaterials, source, producer);
      if (!producer?.runId || !producer.worldProductionRecoveryRef) throw new Error("previous_request_unavailable");
      const original = await readProductionGrant(this.projectRoot, producer.worldProductionRecoveryRef);
      validateProductionBinding(original, producer, this.state.bindings[producer.input?.previousRequestId ?? ""]);
      const rebuilt = await this.productionRecovery(original.recovery.sourceRequestId, depth + 1);
      if (JSON.stringify(rebuilt) !== JSON.stringify(original)) throw new Error("previous_request_unavailable");
      const proven = await retainedProductionMaterials(await this.flow.request<FlowRun>("get", { id: producer.runId }),
        productionMaterials.materials.sourceRequestId, id => this.flow.request<FlowRun>("get", { id }), original, source.input.text);
      if (JSON.stringify(proven) !== JSON.stringify(productionMaterials)) throw new Error("previous_request_unavailable");
    }
    let maxRepairRounds = 3;
    try { const policy = JSON.parse(await readFile(join(this.projectRoot, ".aura", "world-agent-budget.json"), "utf8"));
      if (Number.isInteger(policy.maxRepairRounds) && policy.maxRepairRounds >= 0 && policy.maxRepairRounds <= 3) maxRepairRounds = policy.maxRepairRounds;
    } catch { /* The default is still bounded. Paid work is separately forbidden. */ }
    return retainedWorldProduction(await this.flow.request<FlowRun>("get", { id: source.runId }), sourceRequestId,
      id => this.flow.request<FlowRun>("get", { id }), { playerId: source.playerId, homeWorldId: source.homeWorldId,
        creationSessionId: source.creationSessionId!, textHash: source.textHash },
      { design: source.worldDesignRecovery, assets: source.assetReuse, production: prior, productionMaterials }, maxRepairRounds);
  }

  async submit(client: Client, requestId: string, input: CreationInput) {
    if (!uuid.test(requestId)) throw new Error("invalid_request");
    const kind = input.operation === "create_prop" ? "prop" : "world";
    const textHash = sha(input.text), requestHash = sha(JSON.stringify(input));
    return this.serial(async () => {
      if (input.craft) {
        const catalog = await this.flow.request<FlowCatalog>("catalog");
        if (!catalog.flows.some(f => f.id === "veya/veya-gameplay-craft" && f.available && f.service)) throw new Error("craft_flow_unavailable");
      } else if (!await this.wishAvailable()) throw new Error("wish_flow_unavailable");
      const previous = this.state.bindings[requestId];
      if (previous && (previous.playerId !== client.playerId || previous.homeWorldId !== client.homeWorldId ||
          previous.kind !== kind || previous.textHash !== textHash ||
          (previous.requestHash !== undefined && previous.requestHash !== requestHash) ||
          (previous.requestHash === undefined && JSON.stringify(input) !== JSON.stringify({ operation: kind === "prop" ? "create_prop" : "create_world", text: input.text })) ||
          previous.sessionPath !== client.sessionPath || previous.creationSessionId !== client.creationSessionId))
        throw new Error("request_id_conflict");
      if (!previous) {
        let craftAuthorizationDigest: string | undefined;
        if (input.craft) {
          if (!client.foregroundSessionPath) throw new Error("craft_foreground_unavailable");
          craftAuthorizationDigest = await admitVeyaCraft(client.foregroundSessionPath, input.craft);
          // An order owns one durable Run. A lost local receipt must never start
          // a second paid generation under a new request UUID.
          for (const other of Object.values(this.state.bindings)) if (other.playerId === client.playerId &&
              other.craftAuthorization?.worldId === input.craft.worldId && other.craftAuthorization.orderId === input.craft.orderId)
            throw new Error("craft_order_already_bound");
        }
        if ((await readCreatorLeases(this.projectRoot)).leases[client.creationSessionId]) throw new Error("worker_busy");
        for (const [id, other] of Object.entries(this.state.bindings)) {
          if (id === requestId || other.creationSessionId !== client.creationSessionId) continue;
          if (!other.runId) throw new Error("worker_busy");
          const current = await this.flow.request<FlowRun>("get", { id: other.runId });
          if (!["completed", "failed", "cancelled", "interrupted"].includes(current.status)) throw new Error("worker_busy");
        }
        let previousArtifact: PreviousArtifact | undefined;
        let recovery: PropRecovery | undefined, recoveryBudgetCreationId: string | undefined;
        let worldDesignRecovery: WorldDesignRecovery | undefined;
        let worldProductionRecoveryRef: ProductionGrantRef | undefined;
        let productionRecoveryClaim: string | undefined;
        let productionMaterialsRef: ProductionGrantRef | undefined;
        let assetReuse: AssetReuseGrant | undefined;
        if (input.reuseProductionFromRequestId) {
          const source = this.state.bindings[input.reuseProductionFromRequestId];
          if (!source?.runId || !source.worldProductionRecoveryRef || source.productionMaterialsRef ||
              source.input?.operation !== "create_world" ||
              ["playerId", "homeWorldId", "creationSessionId", "sessionPath"].some(k => (source as any)[k] !== (client as any)[k]))
            throw new Error("production_materials_unavailable");
          const prior = await readProductionGrant(this.projectRoot, source.worldProductionRecoveryRef);
          validateProductionBinding(prior, source, this.state.bindings[source.input.previousRequestId ?? ""]);
          const rebuilt = await this.productionRecovery(prior.recovery.sourceRequestId);
          if (JSON.stringify(rebuilt) !== JSON.stringify(prior)) throw new Error("production_materials_unavailable");
          const grant = await retainedProductionMaterials(await this.flow.request<FlowRun>("get", { id: source.runId }), input.reuseProductionFromRequestId,
            id => this.flow.request<FlowRun>("get", { id }), prior, input.text);
          productionMaterialsRef = await writeMaterialsGrant(this.projectRoot, grant);
          recoveryBudgetCreationId = source.recoveryBudgetCreationId ?? input.reuseProductionFromRequestId;
        }
        if (input.reuseAssetsFromRequestId) {
          const source = this.state.bindings[input.reuseAssetsFromRequestId];
          if (!source?.runId || source.playerId !== client.playerId || source.homeWorldId !== client.homeWorldId ||
              source.creationSessionId !== client.creationSessionId || source.sessionPath !== client.sessionPath ||
              source.input?.operation !== "create_world" || source.input.text !== input.text ||
              source.recovery || source.worldDesignRecovery || source.assetReuse) throw new Error("asset_reuse_unavailable");
          assetReuse = await retainedCommonAssets(await this.flow.request<FlowRun>("get", { id: source.runId }), input.reuseAssetsFromRequestId,
            id => this.flow.request<FlowRun>("get", { id }));
        }
        if (input.previousRequestId) {
          const source = this.state.bindings[input.previousRequestId];
          if (!source?.runId || source.playerId !== client.playerId || source.homeWorldId !== client.homeWorldId ||
              source.creationSessionId !== client.creationSessionId || source.sessionPath !== client.sessionPath ||
              source.input?.operation !== input.operation || source.input.text !== input.text ||
              source.input.previousArtifactId) throw new Error("previous_request_unavailable");
          recoveryBudgetCreationId = source.recoveryBudgetCreationId ?? input.previousRequestId;
          if (input.operation === "create_world") {
            const sourceRun = await this.flow.request<FlowRun>("get", { id: source.runId });
            if (source.worldProductionRecoveryRef || hasWorldProductionResume(sourceRun)) {
              const grant = await this.productionRecovery(input.previousRequestId);
              worldProductionRecoveryRef = await writeProductionGrant(this.projectRoot, grant);
              if (!grant.proof.pendingRound) productionRecoveryClaim = productionRecoveryBoundary(grant);
            } else {
            worldDesignRecovery = await retainedWorldDesign(sourceRun, input.previousRequestId,
              id => this.flow.request<FlowRun>("get", { id }), source.worldDesignRecovery);
            if (source.assetReuse) {
              const grant = readAssetReuseGrant(source.assetReuse), origin = this.state.bindings[grant.sourceRequestId];
              const first = source.worldDesignRecovery ? this.state.bindings[source.input.previousRequestId ?? ""] : undefined;
              if (source.worldDesignRecovery) validateInheritedAssetReuseBinding(source, first);
              else if (source.recovery || source.recoveryBudgetCreationId || source.input.reuseAssetsFromRequestId !== grant.sourceRequestId)
                throw new Error("asset_reuse_unavailable");
              if (!origin?.runId || origin.runId !== grant.sourceRunId ||
                  origin.playerId !== client.playerId || origin.homeWorldId !== client.homeWorldId ||
                  origin.creationSessionId !== client.creationSessionId || origin.sessionPath !== client.sessionPath ||
                  origin.input?.text !== input.text || origin.input.operation !== input.operation ||
                  origin.assetReuse || origin.recovery || origin.worldDesignRecovery) throw new Error("asset_reuse_unavailable");
              const proven = await retainedCommonAssets(await this.flow.request<FlowRun>("get", { id: origin.runId }),
                grant.sourceRequestId, id => this.flow.request<FlowRun>("get", { id }));
              if (JSON.stringify(proven) !== JSON.stringify(grant)) throw new Error("asset_reuse_unavailable");
              assetReuse = await inheritedDesignAssets(sourceRun, worldDesignRecovery.plan, proven, id => this.flow.request<FlowRun>("get", { id }));
              validateInheritedAssetReuseBinding({ playerId: client.playerId, homeWorldId: client.homeWorldId,
                creationSessionId: client.creationSessionId, sessionPath: client.sessionPath, input,
                worldDesignRecovery, assetReuse, recoveryBudgetCreationId }, source, first);
              if (Buffer.byteLength(JSON.stringify({ worldDesignRecovery, assetReuse })) > 240 * 1024) throw new Error("previous_request_unavailable");
            }
            }
          }
          else recovery = await retainedPropWork(await this.flow.request<FlowRun>("get", { id: source.runId }),
              input.previousRequestId, recoveryBudgetCreationId, this.projectRoot, id => this.flow.request<FlowRun>("get", { id }), source.recovery);
        }
        if (input.previousArtifactId) {
          for (const other of Object.values(this.state.bindings)) {
            if (other.playerId !== client.playerId || other.homeWorldId !== client.homeWorldId ||
                other.creationSessionId !== client.creationSessionId || other.sessionPath !== client.sessionPath || !other.runId) continue;
            try {
              const artifact = await this.artifact(other);
              if (artifact.metadata.artifactId === input.previousArtifactId) {
                previousArtifact = artifact.metadata as PreviousArtifact;
                break;
              }
            } catch { /* Another unfinished or invalid artifact grants no access. */ }
          }
          if (!previousArtifact || (input.operation === "create_prop") !== (previousArtifact.kind === "prop"))
            throw new Error("previous_artifact_unavailable");
        }
        await this.commit({ version: 1, bindings: { ...this.state.bindings,
          [requestId]: { playerId: client.playerId, homeWorldId: client.homeWorldId,
            kind, textHash, requestHash, input, ...(input.craft ? { craftAuthorization: input.craft, craftAuthorizationDigest, foregroundSessionPath: client.foregroundSessionPath } : {}), ...(previousArtifact ? { previousArtifact } : {}),
            ...(recovery ? { recovery, recoveryBudgetCreationId } : {}),
            ...(worldDesignRecovery ? { worldDesignRecovery, recoveryBudgetCreationId } : {}),
            ...(worldProductionRecoveryRef ? { worldProductionRecoveryRef, recoveryBudgetCreationId } : {}),
            ...(productionRecoveryClaim ? { productionRecoveryClaimVersion: 1 as const, productionRecoveryClaim } : {}),
            ...(productionMaterialsRef ? { productionMaterialsRef, recoveryBudgetCreationId } : {}),
            ...(assetReuse ? { assetReuse } : {}),
            sessionPath: client.sessionPath, creationSessionId: client.creationSessionId },
        } }); // Worker binding exists before the Run can execute.
      }
      const run = await this.flow.request<FlowRun>("start", {
        requestId, flowId: input.craft ? "veya/veya-gameplay-craft" : "veya/veya-wish", serviceOnly: true, useConfiguredModel: true, mode: "codex",
        input: input.craft ?? { ...input, kind, homeWorldId: client.homeWorldId },
      });
      if (previous?.runId && previous.runId !== run.id) throw new Error("run_identity_conflict");
      await this.commit({ version: 1, bindings: { ...this.state.bindings,
        [requestId]: { ...this.state.bindings[requestId]!, runId: run.id },
      } });
      return { requestId, runId: run.id, runStatus: run.status };
    });
  }

  async artifact(binding: Binding) {
    if (!binding.runId) throw new Error("artifact_not_ready");
    const run = await this.flow.request<FlowRun>("get", { id: binding.runId });
    const lease = binding.creationSessionId ? (await readCreatorLeases(this.projectRoot)).leases[binding.creationSessionId] : undefined;
    if (lease?.rootRunId === run.id) throw new Error("artifact_not_ready");
    if (run.status !== "completed") throw new Error("artifact_not_ready");
    return creatorArtifact(binding.sessionPath, binding.craftAuthorization && object(run.output)?.status === "ready_to_assemble" ? { ...object(run.output), status: "ready" } : run.output, binding.creationSessionId);
  }

  async answer(client: Client, requestId: string, commandId: string, checkpointRunId: string, stepKey: string, answer: unknown) {
    return this.serial(async () => {
      const binding = this.owned(client, requestId);
      if (!binding) throw new Error("not_found");
      const fingerprint = sha(JSON.stringify({ checkpointRunId, stepKey, answer }));
      const prior = binding.answers?.[commandId];
      if (prior && prior.fingerprint !== fingerprint) throw new Error("stale_checkpoint");
      if (prior?.accepted) return;
      if (!prior) {
        const state = await this.project(binding);
        if (!("checkpoint" in state) || !state.checkpoint || state.checkpoint.runId !== checkpointRunId || state.checkpoint.stepKey !== stepKey)
          throw new Error("stale_checkpoint");
        if (Object.keys(binding.answers ?? {}).length >= 12) throw new Error("answer_limit");
        await this.commit({ version: 1, bindings: { ...this.state.bindings, [requestId]: { ...binding,
          answers: { ...binding.answers, [commandId]: { fingerprint, checkpointRunId, stepKey, accepted: false } } } } });
      }
      await this.flow.request("answer", { id: checkpointRunId, stepKey, requestId: commandId, output: answer });
      const current = this.state.bindings[requestId]!;
      await this.commit({ version: 1, bindings: { ...this.state.bindings, [requestId]: { ...current,
        answers: { ...current.answers, [commandId]: { fingerprint, checkpointRunId, stepKey, accepted: true } } } } });
    });
  }

  owned(client: Client, requestId: string): Binding | undefined {
    const binding = this.state.bindings[requestId];
    return binding?.playerId === client.playerId && binding.homeWorldId === client.homeWorldId
      ? binding : undefined;
  }
  async reconcileCraft(client: Client, requestId: string, scope: VeyaCraftScope) {
    return this.serial(async () => {
      const binding=this.owned(client,requestId),original=binding?.craftOriginalAuthorization ?? binding?.craftAuthorization;
      if(!binding||!original||!client.foregroundSessionPath||original.worldId!==scope.worldId||original.orderId!==scope.orderId)throw new Error("craft_reconcile_refused");
      const digest=await admitVeyaCraft(client.foregroundSessionPath,scope);
      if(digest!==binding.craftAuthorizationDigest)throw new Error("craft_reconcile_refused");
      const next={...binding,craftOriginalAuthorization:original,craftAuthorization:scope,foregroundSessionPath:client.foregroundSessionPath};
      await this.commit({version:1,bindings:{...this.state.bindings,[requestId]:next}});
      return next;
    });
  }

  list(client: Client) {
    return Object.entries(this.state.bindings)
      .filter(([, binding]) => binding.playerId === client.playerId && binding.homeWorldId === client.homeWorldId)
      .map(([requestId, binding]) => ({ requestId, runId: binding.runId, kind: binding.kind, text: binding.input?.text ?? "", ...(binding.craftAuthorization ? { craft: binding.craftAuthorization } : {}), operation: binding.input?.operation ?? (binding.kind === "prop" ? "create_prop" : "create_world") }));
  }

  async project(binding: Binding) {
    const text = binding.input?.text ?? "";
    if (!binding.runId) return { text, runStatus: "queued", deliveryStatus: "not_ready" };
    const run = await this.flow.request<FlowRun>("get", { id: binding.runId });
    // Only fixed product reason codes cross into the game. Provider payloads,
    // worker diagnostics, credentials and paths stay in backend diagnostics.
    const failureReason = run.status === "completed" && object(run.output)?.status === "blocked" ? "production_failed" : run.status === "failed"
      ? run.error === "creator_worker_capabilities_unavailable" || run.error === "creator_worker_binding_unavailable"
        ? "worker_unavailable"
        : run.error?.startsWith("creator_worker_upgrade_required:") ? "worker_upgrade_required"
        : run.error === "model_unauthorized" ? "model_unauthorized" : "production_failed"
      : run.status === "cancelled" ? "cancelled"
      : run.status === "needs_attention" ? "production_needs_attention"
      : run.status === "interrupted" ? "interrupted" : "";
    const runStatus = run.status === "completed" && failureReason === "production_failed" ? "failed" : run.status;
    const lease = binding.creationSessionId ? (await readCreatorLeases(this.projectRoot)).leases[binding.creationSessionId] : undefined;
    if (lease?.rootRunId === run.id && (lease.cancelling || lease.state === "needs_attention" ||
        ["completed", "failed", "cancelled", "interrupted"].includes(run.status)))
      return { text, failureReason, runId: run.id, runStatus, phase: "needs_attention", deliveryStatus: "not_ready", cleanup: "needs_attention" };
    let current = run;
    for (let depth = 0; depth < 8; ++depth) {
      const child = current.steps.find((step) => step.kind === "flow" && step.status === "waiting_input" && step.childRunId);
      if (!child || child.kind !== "flow" || !child.childRunId) break;
      current = await this.flow.request<FlowRun>("get", { id: child.childRunId });
    }
    const waiting = current.steps.find((step) => step.kind === "checkpoint" && step.status === "waiting_input");
    const checkpoint = waiting?.kind === "checkpoint" && waiting.stepKey
      ? { runId: current.id, stepKey: waiting.stepKey, prompt: waiting.prompt, schema: waiting.outputSchema }
      : undefined;
    let artifact: Awaited<ReturnType<typeof creatorArtifact>> | undefined;
    if (run.status === "completed") {
      try { artifact = await this.artifact(binding); } catch { /* No unverified delivery projection. */ }
    }
    const verified = artifact !== undefined;
    return {
      text, failureReason: failureReason || (run.status === "completed" && !verified ? "delivery_unverified" : ""),
      runId: run.id, runStatus,
      phase: run.status === "needs_attention" ? "needs_attention" : run.status === "waiting_input" ? "clarification" :
        run.status === "completed" ? (verified ? "preparing_delivery" : "needs_attention") : "production",
      deliveryStatus: verified ? "pending_delivery" : "not_ready",
      ...(binding.craftAuthorization ? { craft: binding.craftAuthorization, craftStatus: object(run.output)?.status,
        craftPlan: object(run.output)?.plan, craftReason: object(run.output)?.reasonCode } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(artifact ? artifact.metadata : {}),
    };
  }
}

export function createVeyaCreatorApp(service: VeyaCreatorService) {
  const app = new Hono<{ Variables: { creatorClient: Client } }>();
  app.use("*", bodyLimit({ maxSize: 32 * 1024, onError: (context) => context.json({ error: "request_too_large" }, 413) }));
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.post("/clients", async (context) => {
    if (!safe(context.req.header("authorization")?.replace(/^Bearer /u, "") ?? "", service.bootstrapToken))
      return context.json({ error: "unauthorized" }, 401);
    const body = await boundedObject(context.req.raw);
    try {
      if (!body || typeof body.playerId !== "string" || typeof body.homeWorldId !== "string" ||
          typeof body.workerSessionPath !== "string") throw new Error("invalid_client");
      if (body.foregroundSessionPath !== undefined && typeof body.foregroundSessionPath !== "string") throw new Error("invalid_client");
      const token = await service.register(body.playerId, body.homeWorldId, body.workerSessionPath, body.foregroundSessionPath as string | undefined);
      return context.json({ token }, 201);
    } catch { return context.json({ error: "invalid_client" }, 400); }
  });
  app.use("/*", async (context, next) => {
    const client = service.client(context.req.header("authorization"));
    if (!client) return context.json({ error: "unauthorized" }, 401);
    context.set("creatorClient", client);
    await next();
  });
  app.get("/tasks", (context) => context.json({ tasks: service.list(context.get("creatorClient") as Client) }));
  app.get("/status", async (context) => {
    try { return context.json({ connected: true, wishFlowAvailable: await service.wishAvailable() }); }
    catch { return context.json({ connected: false, wishFlowAvailable: false }, 503); }
  });
  app.post("/tasks", async (context) => {
    const body = await boundedObject(context.req.raw);
    if (!body || typeof body.requestId !== "string") return context.json({ error: "invalid_request" }, 400);
    let input: CreationInput;
    try { input = creationInput(body); } catch { return context.json({ error: "invalid_request" }, 400); }
    try { return context.json(await service.submit(context.get("creatorClient") as Client,
      body.requestId, input), 202); }
    catch (error) {
      const code = error instanceof Error && ["request_id_conflict", "worker_busy", "previous_artifact_unavailable", "previous_request_unavailable", "asset_reuse_unavailable", "production_materials_unavailable"].includes(error.message) ? error.message : "creation_unavailable";
      return context.json({ error: code }, code === "creation_unavailable" ? 503 : 409);
    }
  });
  app.get("/tasks/:requestId", async (context) => {
    const binding = service.owned(context.get("creatorClient") as Client, context.req.param("requestId"));
    if (!binding) return context.json({ error: "not_found" }, 404);
    try { return context.json(await service.project(binding)); }
    catch { return context.json({ error: "creation_unavailable" }, 503); }
  });
  app.post("/tasks/:requestId/answer", async (context) => {
    const binding = service.owned(context.get("creatorClient") as Client, context.req.param("requestId"));
    if (!binding) return context.json({ error: "not_found" }, 404);
    const body = await boundedObject(context.req.raw);
    if (!body || typeof body.commandId !== "string" || !uuid.test(body.commandId) ||
        typeof body.stepKey !== "string" || typeof body.checkpointRunId !== "string" || !uuid.test(body.checkpointRunId))
      return context.json({ error: "invalid_answer" }, 400);
    try {
      await service.answer(context.get("creatorClient") as Client, context.req.param("requestId"),
        body.commandId, body.checkpointRunId, body.stepKey, body.answer);
      return context.json({ accepted: true });
    } catch (error) {
      if (error instanceof Error && error.message === "stale_checkpoint") return context.json({ error: "stale_checkpoint" }, 409);
      return context.json({ error: "answer_unavailable" }, 503);
    }
  });
  app.get("/tasks/:requestId/artifact", async context => {
    const binding = service.owned(context.get("creatorClient"), context.req.param("requestId"));
    if (!binding) return context.json({ error: "not_found" }, 404);
    try {
      const artifact = await service.artifact(binding);
      return new Response(new Uint8Array(artifact.bytes), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } catch { return context.json({ error: "artifact_unavailable" }, 409); }
  });
  app.get("/tasks/:requestId/artifact/blobs/:blobId", async context => {
    const binding = service.owned(context.get("creatorClient"), context.req.param("requestId"));
    if (!binding) return context.json({ error: "not_found" }, 404);
    try {
      const artifact = await service.artifact(binding);
      return new Response(new Uint8Array(await artifact.blob(context.req.param("blobId"))), { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
    } catch { return context.json({ error: "artifact_unavailable" }, 409); }
  });
  for (const command of ["cancel", "resume"] as const)
    app.post(`/tasks/:requestId/${command}`, async (context) => {
      const binding = service.owned(context.get("creatorClient") as Client, context.req.param("requestId"));
      if (!binding?.runId) return context.json({ error: "not_found" }, 404);
      const body = await boundedObject(context.req.raw);
      if (!body || typeof body.commandId !== "string" || !uuid.test(body.commandId))
        return context.json({ error: "invalid_command" }, 400);
      try {
        if(command==="resume"&&binding.craftAuthorization){
          await service.reconcileCraft(context.get("creatorClient"),context.req.param("requestId"),readVeyaCraftScope(body.craft));
        }
        const run=await service.flow.request<FlowRun>("get",{id:binding.runId});
        if(run.status!=="completed")await service.flow.request(command, { id: binding.runId, requestId: body.commandId });
        return context.json({ accepted: true });
      } catch { return context.json({ error: "creation_unavailable" }, 503); }
    });
  return app;
}
