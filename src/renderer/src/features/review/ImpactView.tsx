import { useEffect, useId, useMemo, useState } from 'react';
import type { ImpactMap, ImpactNode } from '../../../../shared/impact';
import { Icon } from '../../ds';
import { api, errorMessage, run } from '../../lib/api';
import { layoutImpact, NODE_H, NODE_W } from './impactLayout';

interface Props {
  targetKey: string;
  /** Files in this diff; a node elsewhere opens on GitHub instead. */
  diffPaths: ReadonlySet<string>;
  onJumpPath: (path: string) => void;
  onOpenNode: (node: ImpactNode) => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; targetKey: string; message: string }
  | { kind: 'ready'; targetKey: string; map: ImpactMap };

const actionOf = (node: ImpactNode, diffPaths: ReadonlySet<string>): string =>
  node.changed
    ? 'Show the change in the diff'
    : diffPaths.has(node.path)
      ? 'Show in the diff'
      : 'Open on GitHub at this commit';

function ImpactGraph({
  map,
  diffPaths,
  onOpen,
}: {
  map: ImpactMap;
  diffPaths: ReadonlySet<string>;
  onOpen: (node: ImpactNode) => void;
}) {
  const layout = useMemo(() => layoutImpact(map), [map]);
  const [active, setActive] = useState<string | null>(null);
  const linked = useMemo(() => {
    if (!active) return null;
    const ids = new Set([active]);
    for (const edge of map.edges) {
      if (edge.from === active) ids.add(edge.to);
      if (edge.to === active) ids.add(edge.from);
    }
    return ids;
  }, [active, map.edges]);
  const marker = useId().replace(/:/g, '');

  return (
    <div className="impact-graph">
      <div className="impact-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="impact-edges"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          <defs>
            {['', '-on'].map((suffix) => (
              <marker
                key={suffix}
                id={`${marker}${suffix}`}
                className={`impact-arrow${suffix}`}
                viewBox="0 0 8 8"
                refX="6"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => {
            const on = active !== null && (edge.from === active || edge.to === active);
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                d={edge.d}
                className={`impact-edge${edge.back ? ' back' : ''}${on ? ' on' : active ? ' dim' : ''}`}
                markerEnd={`url(#${marker}${on ? '-on' : ''})`}
              />
            );
          })}
        </svg>
        {layout.columns.map((column, index) => (
          <span key={index} className="impact-label impact-column-label" style={{ left: column.x }}>
            {column.label}
          </span>
        ))}
        {layout.nodes.map(({ node, x, y }) => {
          const action = actionOf(node, diffPaths);
          const outside = !diffPaths.has(node.path);
          return (
            <button
              key={node.id}
              className={`impact-node${node.changed ? ' changed' : ''}${outside ? ' outside' : ''}${linked && !linked.has(node.id) ? ' dim' : ''}`}
              style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
              title={`${node.container ? `${node.container}.` : ''}${node.name}\n${node.path}:${node.startLine}\n${action}`}
              aria-label={`${node.name}${node.changed ? ', changed' : ''}, ${node.path} line ${node.startLine}. ${action}`}
              onClick={() => onOpen(node)}
              onMouseEnter={() => setActive(node.id)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(node.id)}
              onBlur={() => setActive(null)}
            >
              <span className="impact-node-name">{node.name}</span>
              {node.test ? (
                <span className="impact-node-kind">test</span>
              ) : node.kind === 'module' ? (
                <span className="impact-node-kind">top level</span>
              ) : outside ? (
                <Icon name="arrowUpRight" size={12} />
              ) : null}
              <span className="impact-node-path">
                {node.path}:{node.startLine}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ImpactView({ targetKey, diffPaths, onJumpPath, onOpenNode }: Props) {
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

  if (state.kind === 'loading' || state.targetKey !== targetKey)
    return (
      <section className="impact-page">
        <p className="impact-loading">Building the impact graph from the repository snapshot…</p>
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

  const { map } = state;
  const changed = map.nodes.filter((node) => node.changed).length;
  return (
    <section className="impact-page" aria-label="Code impact map">
      <header className="impact-head">
        <div>
          <span className="card-kicker">Dependency graph</span>
          <h2>Code impact</h2>
          <p>
            {changed} changed · {map.nodes.length - changed} connected · {map.scannedFiles} source
            files scanned
            {map.skippedFiles ? ` · ${map.skippedFiles} not mapped` : ''}
          </p>
        </div>
        <div className="impact-legend" aria-label="Legend">
          <span className="impact-swatch changed">Changed</span>
          <span className="impact-swatch">In this diff</span>
          <span className="impact-swatch outside">Elsewhere · opens on GitHub</span>
        </div>
      </header>
      {map.languages.length > 0 && (
        <ul className="impact-languages" aria-label="Languages">
          {map.languages.map((language) => (
            <li key={language.language} className={`impact-language ${language.status}`}>
              <b>{language.label}</b>
              <span>
                {language.status === 'mapped'
                  ? `mapped · ${language.detail ?? ''}`
                  : language.status === 'off'
                    ? 'not mapped'
                    : 'failed'}
              </span>
              {language.status !== 'mapped' && language.detail && <small>{language.detail}</small>}
            </li>
          ))}
        </ul>
      )}
      {map.omittedChanged > 0 && (
        <p className="impact-none">
          {map.omittedChanged} more changed function{map.omittedChanged === 1 ? ' is' : 's are'} not
          drawn, to keep the graph readable.
        </p>
      )}
      {!changed ? (
        <p className="impact-empty">
          No changed functions or blocks were found in the languages mapped for this diff.
        </p>
      ) : (
        <ImpactGraph map={map} diffPaths={diffPaths} onOpen={onOpenNode} />
      )}
      <div className="impact-details">
        <section className="impact-section">
          <h3>Imported modules</h3>
          {map.imports.length ? (
            <ul className="impact-list">
              {map.imports.map((imp) => (
                <li key={`${imp.path}:${imp.module}`}>
                  <button
                    disabled={!imp.resolvedPath || !diffPaths.has(imp.resolvedPath)}
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
          {map.tests.length ? (
            <ul className="impact-list">
              {map.tests.map((test) => (
                <li key={test.path}>
                  <button
                    disabled={!diffPaths.has(test.path)}
                    onClick={() => onJumpPath(test.path)}
                  >
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
            <p className="impact-none">No associated test found.</p>
          )}
        </section>
      </div>
      <p className="impact-disclaimer">
        Built locally from the head commit. Code uses each language's call hierarchy—the same one an
        editor shows—and Terraform uses static block references. Remote state is represented by its
        local data source; its backend and other repositories are never read. Dependencies that
        cannot be resolved inside this repository are not drawn rather than guessed.
      </p>
    </section>
  );
}
