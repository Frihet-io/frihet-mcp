export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isMissingModule =
      error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND";
    const isRelativeJavaScriptImport = specifier.startsWith(".") && specifier.endsWith(".js");

    if (!isMissingModule || !isRelativeJavaScriptImport) {
      throw error;
    }

    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith("/package.json") && context.importAttributes.type === undefined) {
    return nextLoad(url, {
      ...context,
      importAttributes: { ...context.importAttributes, type: "json" },
    });
  }

  return nextLoad(url, context);
}
