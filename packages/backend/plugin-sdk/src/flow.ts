import {
  defineFlow as defineInternalFlow,
  z,
  type FlowDefinition as InternalFlowDefinition,
  type FlowScope,
} from "@aura/orchestration/flow";

export { z };
export type {
  FlowActionRequest,
  FlowActionResult,
  FlowAgentRequest,
  FlowAgentResult,
  FlowMode,
  FlowRetry,
  FlowScope,
} from "@aura/orchestration/flow";

/** External plugins receive a usable root scope while Aura keeps its internal replay root. */
export type FlowContext = FlowScope;

export type FlowDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> = Omit<InternalFlowDefinition<InputSchema, OutputSchema>, "run"> & {
  run(
    context: FlowScope,
    input: z.output<InputSchema>,
  ): Promise<z.input<OutputSchema>> | z.input<OutputSchema>;
};

/** Adapts the public v1 plugin contract to Aura's durable root sequence. */
export function defineFlow<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(definition: FlowDefinition<InputSchema, OutputSchema>) {
  return defineInternalFlow({
    ...definition,
    run(context, input) {
      return context.sequence({ id: "plugin" }, (scope) =>
        definition.run(scope, input),
      );
    },
  });
}
