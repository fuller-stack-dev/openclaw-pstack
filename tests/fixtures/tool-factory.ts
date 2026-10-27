/** Builds a registered tool the way the host does: a v1 function factory or a v2 descriptor. */
export const build = (registration: any, context: any) =>
  typeof registration === "function" ? registration(context) : registration.create(context);
