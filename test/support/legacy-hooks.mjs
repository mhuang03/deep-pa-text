// Propagates ?gen=N from a parent module to every project-local child so that
// each generation evaluates a fresh copy of the legacy module graph.
const ROOT = new URL('../../', import.meta.url).href;
const isProjectFile = (url) =>
  url.startsWith(ROOT) && !url.includes('/node_modules/') && !url.startsWith(`${ROOT}test/`);

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (!context.parentURL) return result;
  const gen = new URL(context.parentURL).searchParams.get('gen');
  if (!gen || !isProjectFile(result.url)) return result;
  const url = new URL(result.url);
  url.searchParams.set('gen', gen);
  return { ...result, url: url.href };
}
