import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationProject } from "../src/features/coding/conversation-project.ts";

const projects = [
  { id: "work", title: "工作项目", directory: "/work" },
  {
    id: "default",
    title: "默认工作空间",
    directory: "/default",
    isDefault: true,
  },
];

test("opening a new or legacy chat keeps a workspace when the default marker is absent", () => {
  const olderProjects = projects.map(({ id, title, directory }) => ({
    id,
    title,
    directory,
  }));
  assert.equal(conversationProject(olderProjects)?.id, "work");
  assert.equal(conversationProject(olderProjects, "removed")?.id, "work");
});

test("a valid selection wins and otherwise the default workspace is preferred", () => {
  assert.equal(conversationProject(projects, "work")?.id, "work");
  assert.equal(conversationProject(projects)?.id, "default");
  assert.equal(conversationProject(projects, "removed")?.id, "default");
});

test("no workspace is invented before the list is available", () => {
  assert.equal(conversationProject([]), undefined);
  assert.equal(conversationProject([], "removed"), undefined);
});
