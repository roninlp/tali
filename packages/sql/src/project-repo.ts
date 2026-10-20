import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { Project, type ProjectId, type UserId } from "@tali/domain"

/** D1-backed repository for `Project` (ticket #33; FR-TASK-02). Pure persistence. */

const PROJECT_COLUMNS =
  `id, type, title, owner_id AS ownerId, household_id AS householdId, visibility, ` +
  `color, created_at AS createdAt, updated_at AS updatedAt, version, deleted_at AS deletedAt`

export class ProjectRepo extends Context.Service<ProjectRepo>()("ProjectRepo", {
  make: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient

    const findById = (id: ProjectId) =>
      Effect.map(
        sql<Project>`SELECT ${sql.literal(PROJECT_COLUMNS)} FROM projects WHERE id = ${id}`,
        (rows) => Option.fromUndefinedOr(rows[0])
      )

    const listVisible = (input: {
      readonly householdId: string
      readonly userId: UserId
    }) =>
      Effect.map(
        sql<Project>`
          SELECT ${sql.literal(PROJECT_COLUMNS)} FROM projects
          WHERE household_id = ${input.householdId}
            AND deleted_at IS NULL
            AND (owner_id = ${input.userId} OR visibility = 'shared')
          ORDER BY title ASC, id ASC
        `,
        (rows) => rows
      )

    const insert = (project: Project) =>
      Effect.map(
        sql<Project>`
          INSERT INTO projects
            (id, type, title, owner_id, household_id, visibility, color,
             created_at, updated_at, version, deleted_at)
          VALUES
            (${project.id}, ${project.type}, ${project.title}, ${project.ownerId},
             ${project.householdId}, ${project.visibility}, ${project.color},
             ${project.createdAt}, ${project.updatedAt}, ${project.version}, ${project.deletedAt})
          RETURNING ${sql.literal(PROJECT_COLUMNS)}
        `,
        (rows) => rows[0]!
      )

    const update = (project: Project) =>
      Effect.map(
        sql<Project>`
          UPDATE projects SET
            title = ${project.title},
            visibility = ${project.visibility},
            color = ${project.color},
            updated_at = ${project.updatedAt},
            version = ${project.version},
            deleted_at = ${project.deletedAt}
          WHERE id = ${project.id}
          RETURNING ${sql.literal(PROJECT_COLUMNS)}
        `,
        (rows) => Option.fromUndefinedOr(rows[0])
      )

    return { findById, listVisible, insert, update } as const
  })
}) {}

export const ProjectRepoLive = Layer.effect(ProjectRepo, ProjectRepo.make)
