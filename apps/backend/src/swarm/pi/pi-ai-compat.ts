/**
 * Narrow Forge seam for legacy Pi AI globals.
 *
 * Import catalog/dispatch helpers and shared types from here so Forge stays on
 * `@earendil-works/pi-ai/compat` and does not consume the collection-API root.
 * Raw provider helpers belong on `@earendil-works/pi-ai/api/*` at call sites.
 */
export {
  complete,
  getModel,
  getModels,
  getProviders,
  registerFauxProvider,
  streamSimple,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type TextContent,
  type Transport,
} from "@earendil-works/pi-ai/compat";
