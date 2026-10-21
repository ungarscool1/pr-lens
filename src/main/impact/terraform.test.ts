import { describe, expect, it } from 'vitest';
import type { DiffModel } from '../../shared/diff';
import { analyzeTerraformImpact } from './terraform';

const diffAt = (path: string, line: number): DiffModel => ({
  files: [
    {
      fid: 'F1',
      path,
      status: 'modified',
      binary: false,
      additions: 1,
      deletions: 0,
      noise: null,
      hunks: [
        {
          header: '@@',
          lines: [{ id: 'F1-001', kind: 'add', new: line, text: 'changed' }],
        },
      ],
    },
  ],
});

const app = `data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "company-state"
    key    = "network/terraform.tfstate"
  }
}

resource "aws_instance" "web" {
  subnet_id = data.terraform_remote_state.network.outputs.public_subnet_id
}

output "instance_id" {
  value = aws_instance.web.id
}
`;

describe('Terraform impact analysis', () => {
  it('maps terraform_remote_state to its local consumers without following the remote state', () => {
    const map = analyzeTerraformImpact({
      sources: [
        { path: 'environments/app/main.tf', text: app },
        {
          path: 'environments/network/outputs.tf',
          text: 'output "public_subnet_id" {\n  value = aws_subnet.public.id\n}\n',
        },
      ],
      diff: diffAt('environments/app/main.tf', 2),
      skippedFiles: 0,
    });

    expect(map.nodes.map((node) => [node.name, node.changed])).toEqual([
      ['data.terraform_remote_state.network', true],
      ['aws_instance.web', false],
    ]);
    const byName = new Map(map.nodes.map((node) => [node.name, node.id]));
    expect(map.edges).toEqual([
      {
        from: byName.get('aws_instance.web'),
        to: byName.get('data.terraform_remote_state.network'),
      },
    ]);
    expect(map.nodes.some((node) => node.path === 'environments/network/outputs.tf')).toBe(false);
  });

  it('shows both dependencies and dependants of a changed Terraform block', () => {
    const map = analyzeTerraformImpact({
      sources: [{ path: 'environments/app/main.tf', text: app }],
      diff: diffAt('environments/app/main.tf', 10),
      skippedFiles: 3,
    });

    expect(map.nodes.map((node) => node.name)).toEqual([
      'aws_instance.web',
      'data.terraform_remote_state.network',
      'output.instance_id',
    ]);
    expect(map.edges).toHaveLength(2);
    expect(map.scannedFiles).toBe(1);
    expect(map.skippedFiles).toBe(3);
    expect(map.nodes[0]).toMatchObject({
      changed: true,
      kind: 'resource',
      anchorLineId: 'F1-001',
      startLine: 9,
      endLine: 11,
    });
  });

  it('ignores references and braces in comments and plain strings', () => {
    const text = `${app}\nresource "null_resource" "unrelated" {
  # data.terraform_remote_state.network.outputs.fake }
  triggers = { note = "data.terraform_remote_state.network.outputs.fake }" }
}
`;
    const map = analyzeTerraformImpact({
      sources: [{ path: 'main.tf', text }],
      diff: diffAt('main.tf', 2),
      skippedFiles: 0,
    });

    expect(map.nodes.map((node) => node.name)).toEqual([
      'data.terraform_remote_state.network',
      'aws_instance.web',
    ]);
  });
});
