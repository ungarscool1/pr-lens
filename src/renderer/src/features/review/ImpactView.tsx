import { useEffect, useMemo, useState } from 'react';
import type { ImpactMap, ImpactNode } from '../../../../shared/impact';
import { Icon } from '../../ds';
import { api, errorMessage, run } from '../../lib/api';

interface Props {
  targetKey: string;
  onJumpPath: (path: string) => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; targetKey: string; message: string }
  | { kind: 'ready'; targetKey: string; map: ImpactMap };

const location = (node: ImpactNode): string => `${node.path}:${node.startLine}`;

function FunctionCard({ node, onJump }: { node: ImpactNode; onJump: (path: string) => void }) {
  return (
    <button
      className={`impact-node ${node.changed ? 'changed' : ''}`}
      onClick={() => onJump(node.path)}
    >
      <span className="impact-node-name">{node.name}</span>
      <span className="impact-node-path">{location(node)}</span>
      {node.test && <span className="impact-node-kind">test</span>}
    </button>
  );
}

export function ImpactView({ targetKey, onJumpPath }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    run(api.impact.get({ targetKey }))
      .then((map) => live && setState({ kind: 'ready', targetKey, map }))
      .catch(
        (error: unknown) =>
          live && setState({ kind: 'error', targetKey, message: errorMessage(error) }),
      );
    return () => {
      live = false;
    };
  }, [targetKey]);

  const nodeById = useMemo(
    () =>
      state.kind === 'ready' ? new Map(state.map.nodes.map((node) => [node.id, node])) : new Map(),
    [state],
  );

  if (state.kind === 'loading' || state.targetKey !== targetKey)
    return (
      <section className="impact-page">
        <p className="impact-loading">Building the local TypeScript impact map…</p>
      </section>
    );
  if (state.kind === 'error') {
    return (
      <section className="impact-page">
        <h2>Impact map unavailable</h2>
        <p>{state.message}</p>
      </section>
    );
  }

  const changed = state.map.nodes.filter((node) => node.changed);
  return (
    <section className="impact-page" aria-label="Function impact map">
      <header className="impact-head">
        <div>
          <span className="card-kicker">Static TypeScript map</span>
          <h2>Function impact</h2>
          <p>
            {state.map.scannedFiles} source files scanned
            {state.map.skippedFiles ? ` · ${state.map.skippedFiles} not mapped` : ''}
          </p>
        </div>
        <p className="impact-help">Select a function, module, or test to jump back to its diff.</p>
      </header>
      {!changed.length ? (
        <p className="impact-empty">No changed TypeScript functions were found in this diff.</p>
      ) : (
        <div className="impact-functions">
          {changed.map((node) => {
            const callers = state.map.edges
              .filter((edge) => edge.to === node.id)
              .map((edge) => nodeById.get(edge.from))
              .filter((candidate): candidate is ImpactNode => !!candidate);
            const callees = state.map.edges
              .filter((edge) => edge.from === node.id)
              .map((edge) => nodeById.get(edge.to))
              .filter((candidate): candidate is ImpactNode => !!candidate);
            return (
              <article className="impact-function" key={node.id}>
                <div className="impact-column callers">
                  <span className="impact-label">Called by</span>
                  {callers.length ? (
                    callers.map((caller) => (
                      <FunctionCard key={caller.id} node={caller} onJump={onJumpPath} />
                    ))
                  ) : (
                    <span className="impact-none">No direct caller found</span>
                  )}
                </div>
                <div className="impact-focus">
                  <span className="impact-label">Changed</span>
                  <FunctionCard node={node} onJump={onJumpPath} />
                </div>
                <div className="impact-column callees">
                  <span className="impact-label">Calls</span>
                  {callees.length ? (
                    callees.map((callee) => (
                      <FunctionCard key={callee.id} node={callee} onJump={onJumpPath} />
                    ))
                  ) : (
                    <span className="impact-none">No direct call found</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="impact-details">
        <section className="impact-section">
          <h3>Imported modules</h3>
          {state.map.imports.length ? (
            <ul className="impact-list">
              {state.map.imports.map((imp) => (
                <li key={`${imp.path}:${imp.module}`}>
                  <button
                    disabled={!imp.resolvedPath}
                    onClick={() => imp.resolvedPath && onJumpPath(imp.resolvedPath)}
                  >
                    <Icon name="arrowUpRight" size={13} />
                    <span>{imp.module}</span>
                    <small>{imp.resolvedPath ?? 'external module'}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="impact-none">No imports in changed function files.</p>
          )}
        </section>
        <section className="impact-section">
          <h3>Associated tests</h3>
          {state.map.tests.length ? (
            <ul className="impact-list">
              {state.map.tests.map((test) => (
                <li key={test.path}>
                  <button onClick={() => onJumpPath(test.path)}>
                    <Icon name="arrowUpRight" size={13} />
                    <span>{test.path}</span>
                    <small>
                      {test.relatedNodeIds.length
                        ? `${test.relatedNodeIds.length} direct call${test.relatedNodeIds.length === 1 ? '' : 's'}`
                        : 'imports changed code'}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="impact-none">No associated TypeScript test found.</p>
          )}
        </section>
      </div>
      <p className="impact-disclaimer">
        Local and relative-import calls are resolved syntactically. Dynamic dispatch, path aliases,
        and runtime wiring are intentionally not guessed.
      </p>
    </section>
  );
}
