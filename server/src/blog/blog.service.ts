import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface BlogInput {
  id?: number;
  slug: string;
  title: string;
  excerpt?: string;
  body: string;
  coverUrl?: string;
  tags?: string[];
  status: string;
}

@Injectable()
export class BlogService {
  constructor(private prisma: PrismaService) {}

  published() {
    return this.prisma.blogPost.findMany({
      where: { status: 'published' },
      orderBy: { publishedAt: 'desc' },
    });
  }

  bySlug(slug: string) {
    return this.prisma.blogPost.findUnique({ where: { slug } });
  }

  all() {
    return this.prisma.blogPost.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async upsert(input: BlogInput) {
    const base = {
      slug: input.slug,
      title: input.title,
      excerpt: input.excerpt ?? null,
      body: input.body,
      coverUrl: input.coverUrl ?? null,
      tags: input.tags ?? [],
      status: input.status,
    };
    if (input.id) {
      const existing = await this.prisma.blogPost.findUnique({ where: { id: input.id } });
      const publishedAt =
        input.status === 'published' ? (existing?.publishedAt ?? new Date()) : null;
      return this.prisma.blogPost.update({
        where: { id: input.id },
        data: { ...base, publishedAt },
      });
    }
    const publishedAt = input.status === 'published' ? new Date() : null;
    return this.prisma.blogPost.create({ data: { ...base, source: 'manual', publishedAt } });
  }

  async remove(id: number) {
    await this.prisma.blogPost.delete({ where: { id } });
    return true;
  }
}
