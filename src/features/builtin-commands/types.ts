import type { CommandDefinition } from "../claude-code-command-loader"

export type BuiltinCommandName = "init-deep" | "ralph-loop" | "cancel-ralph" | "fallback-off" | "fallback-on" | "fallback-reset" | "fallback-status"

export interface BuiltinCommandConfig {
  disabled_commands?: BuiltinCommandName[]
}

export type BuiltinCommands = Record<string, CommandDefinition>
