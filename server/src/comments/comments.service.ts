import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SessionUser } from '../auth/auth.service';

export const MAX_COMMENT_LEN = 4000;
export const MAX_COMMENT_DEPTH = 8;

// Soft-deleted rows keep the thread structure: body/name are blanked, the
// node stays so replies under it don't dangle.
function toComment(c: any) {
  const deleted = !!c.deleted;
  return {
    id: c.id,
    parentId: c.parentId,
    userId: c.userId,
    userName: deleted ? '' : c.user?.name || c.user?.username || '',
    body: deleted ? '' : c.body,
    createdAt:
      c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
    isDeleted: deleted,
  };
}

@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService) {}

  async list(productId: number) {
    const rows = await this.prisma.comment.findMany({
      where: { productId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { name: true, username: true } } },
    });
    return rows.map(toComment);
  }

  async add(user: SessionUser, productId: number, body: string, parentId?: number | null) {
    const text = (body ?? '').trim().slice(0, MAX_COMMENT_LEN);
    if (!text) throw new BadRequestException('empty comment');
    const project = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('project not found');

    let pid: number | null = null;
    if (parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: parentId } });
      if (!parent || parent.productId !== productId)
        throw new BadRequestException('parent comment not found');
      if ((await this.depth(parentId)) >= MAX_COMMENT_DEPTH)
        throw new BadRequestException('thread too deep — reply higher up');
      pid = parentId;
    }

    const created = await this.prisma.comment.create({
      data: { productId, parentId: pid, userId: user.i, body: text },
      include: { user: { select: { name: true, username: true } } },
    });
    return toComment(created);
  }

  async remove(user: SessionUser, id: number) {
    const c = await this.prisma.comment.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('not found');
    if (c.userId !== user.i && !user.a)
      throw new ForbiddenException('only the author can delete');
    await this.prisma.comment.update({ where: { id }, data: { deleted: true } });
    return true;
  }

  /** Nesting depth of a would-be reply to parentId (0 = top-level). */
  private async depth(parentId: number): Promise<number> {
    let depth = 0;
    let pid: number | null = parentId;
    while (pid !== null && depth < 20) {
      const row: { parentId: number | null } | null =
        await this.prisma.comment.findUnique({
          where: { id: pid },
          select: { parentId: true },
        });
      if (!row) break;
      depth += 1;
      pid = row.parentId;
    }
    return depth;
  }
}
