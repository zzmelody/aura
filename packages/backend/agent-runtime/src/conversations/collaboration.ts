import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {
  CodingCollaboration,
  CodingCollaborationAction,
  CodingGoalInfo,
  CodingRunIntent,
} from "@aura/protocol/types";
import { z } from "zod";
import { CodedFlowError } from "@aura/protocol/errors";

interface GoalRef {
  id: string;
  revision: number;
}

interface GoalView extends GoalRef, Omit<CodingGoalInfo, "armed"> {
  activation: "armed" | "disarmed";
}

/** Public service methods provided by the pinned DSH base bundle. */
interface Goals {
  get(agent: Agent): GoalView | undefined;
  create(agent: Agent, request: { objective: string }): GoalView;
  resume(agent: Agent, ref: GoalRef): GoalView;
  pause(agent: Agent, ref: GoalRef): GoalView;
  clear(agent: Agent, ref: GoalRef): GoalRef;
  disarm(agent: Agent): GoalView | undefined;
}

interface PlanMode {
  get(agent: Agent): { active: boolean; pending?: boolean };
  set(agent: Agent, active: boolean): unknown;
}

declare module "@deepseek-ai/cordis" {
  interface Events {
    "goal/activation-changed"(event: { sessionId: SessionId }): void;
  }
}

const storedGoal = z.object({
  goal: z.object({
    objective: z.string(),
    phase: z.enum(["active", "paused", "blocked", "complete"]),
    maxGoalRounds: z.number().int().positive(),
  }),
  roundsStarted: z.number().int().nonnegative(),
});

export function isGoalIntent(
  intent: CodingRunIntent | undefined,
): intent is "goal" | "resume-goal" {
  return intent === "goal" || intent === "resume-goal";
}

function ref({ id, revision }: GoalRef): GoalRef {
  return { id, revision };
}

export function codingCollaboration(ctx: Context) {
  const goals = ctx.get("goals") as Goals | undefined;
  const plan = ctx.get("planMode") as PlanMode | undefined;
  if (!goals || !plan)
    throw new CodedFlowError("DSH 对话协作服务不可用。", 503, {
      code: "collaboration_unavailable",
    });

  return {
    current(agent: Agent): CodingCollaboration {
      const { active, pending } = plan.get(agent);
      const goal = goals.get(agent);
      return {
        planning: pending ?? active,
        ...(goal
          ? {
              goal: {
                objective: goal.objective,
                phase: goal.phase,
                armed: goal.activation === "armed",
                roundsStarted: goal.roundsStarted,
                maxGoalRounds: goal.maxGoalRounds,
              },
            }
          : {}),
      };
    },
    async stored(
      sessionId: SessionId,
      signal: AbortSignal,
    ): Promise<CodingCollaboration> {
      const values = (
        await ctx.sessionController.projections({ sessionId }, signal)
      )?.values;
      const savedPlan = z
        .object({ active: z.boolean() })
        .safeParse(values?.plan);
      const goal = storedGoal.safeParse(values?.goal);
      return {
        planning: savedPlan.success && savedPlan.data.active,
        ...(goal.success
          ? {
              goal: {
                ...goal.data.goal,
                roundsStarted: goal.data.roundsStarted,
                armed: false,
              },
            }
          : {}),
      };
    },
    change(agent: Agent, action: CodingCollaborationAction) {
      if (action === "clear-goal") {
        const goal = goals.get(agent);
        if (goal?.activation === "armed")
          throw new CodedFlowError("请先停止目标续跑。", 409, {
            code: "goal_stop_required",
          });
        if (goal) goals.clear(agent, ref(goal));
      } else {
        plan.set(agent, action === "plan");
      }
    },
    startGoal(agent: Agent, intent: "goal" | "resume-goal", objective: string) {
      const goal = goals.get(agent);
      if (intent === "goal" && goal && goal.phase !== "complete")
        throw new CodedFlowError("这段对话已有目标，请先继续或清除它。", 409, {
          code: "goal_exists",
        });
      if (intent === "resume-goal") {
        if (!goal || goal.phase === "complete" || goal.activation === "armed")
          throw new CodedFlowError("当前没有可继续的目标。", 409, {
            code: "goal_not_resumable",
          });
        if (goal.roundsStarted >= goal.maxGoalRounds)
          throw new CodedFlowError("目标已达到续跑轮次上限。", 409, {
            code: "goal_round_limit",
          });
        plan.set(agent, false);
        goals.resume(agent, ref(goal));
        return;
      }
      plan.set(agent, false);
      goals.create(agent, { objective });
    },
    pause(agent: Agent) {
      const goal = goals.get(agent);
      if (goal?.phase === "active" && goal.activation === "armed")
        goals.pause(agent, ref(goal));
    },
    disarm(agent: Agent) {
      if (goals.get(agent)?.activation === "armed") goals.disarm(agent);
    },
  };
}
