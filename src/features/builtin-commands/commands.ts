import type { CommandDefinition } from "../claude-code-command-loader"
import type { BuiltinCommandName, BuiltinCommands } from "./types"
import { INIT_DEEP_TEMPLATE } from "./templates/init-deep"
import { RALPH_LOOP_TEMPLATE, CANCEL_RALPH_TEMPLATE } from "./templates/ralph-loop"
import {
  FALLBACK_OFF_TEMPLATE,
  FALLBACK_ON_TEMPLATE,
  FALLBACK_RESET_TEMPLATE,
  FALLBACK_STATUS_TEMPLATE,
} from "./templates/fallback-commands"

const BUILTIN_COMMAND_DEFINITIONS: Record<BuiltinCommandName, Omit<CommandDefinition, "name">> = {
  "init-deep": {
    description: "(builtin) Initialize hierarchical AGENTS.md knowledge base",
    template: `<command-instruction>
${INIT_DEEP_TEMPLATE}
</command-instruction>

<user-request>
$ARGUMENTS
</user-request>`,
    argumentHint: "[--create-new] [--max-depth=N]",
  },
  "ralph-loop": {
    description: "(builtin) Start self-referential development loop until completion",
    template: `<command-instruction>
${RALPH_LOOP_TEMPLATE}
</command-instruction>

<user-task>
$ARGUMENTS
</user-task>`,
    argumentHint: '"task description" [--completion-promise=TEXT] [--max-iterations=N]',
  },
  "cancel-ralph": {
    description: "(builtin) Cancel active Ralph Loop",
    template: `<command-instruction>
${CANCEL_RALPH_TEMPLATE}
</command-instruction>`,
  },
  "fallback-off": {
    description: "(builtin) Disable rate limit recovery for this session",
    template: `<command-instruction>
${FALLBACK_OFF_TEMPLATE}
</command-instruction>`,
  },
  "fallback-on": {
    description: "(builtin) Enable rate limit recovery for this session",
    template: `<command-instruction>
${FALLBACK_ON_TEMPLATE}
</command-instruction>`,
  },
  "fallback-reset": {
    description: "(builtin) Reset to primary model, ending fallback mode",
    template: `<command-instruction>
${FALLBACK_RESET_TEMPLATE}
</command-instruction>`,
  },
  "fallback-status": {
    description: "(builtin) Show current fallback recovery status",
    template: `<command-instruction>
${FALLBACK_STATUS_TEMPLATE}
</command-instruction>`,
  },
}

export function loadBuiltinCommands(
  disabledCommands?: BuiltinCommandName[]
): BuiltinCommands {
  const disabled = new Set(disabledCommands ?? [])
  const commands: BuiltinCommands = {}

  for (const [name, definition] of Object.entries(BUILTIN_COMMAND_DEFINITIONS)) {
    if (!disabled.has(name as BuiltinCommandName)) {
      commands[name] = {
        name,
        ...definition,
      }
    }
  }

  return commands
}
