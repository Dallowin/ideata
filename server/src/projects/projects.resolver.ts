import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { Facets, Project, ProjectsPage } from './project.model';
import { ProjectsArgs } from './projects.args';
import { ProjectsService } from './projects.service';

@Resolver(() => Project)
export class ProjectsResolver {
  constructor(private readonly svc: ProjectsService) {}

  @Query(() => ProjectsPage, { name: 'projects' })
  projects(@Args() args: ProjectsArgs) {
    return this.svc.list(args);
  }

  @Query(() => Project, { name: 'project', nullable: true })
  project(@Args('id', { type: () => Int }) id: number) {
    return this.svc.one(id);
  }

  @Query(() => Facets, { name: 'facets' })
  facets() {
    return this.svc.facets();
  }
}
