// JSON parsing example.
//
// GET /todo/:id  — fetch a todo from jsonplaceholder.typicode.com, parse the
//                  JSON response into a typed class, and return a reshaped reply.
// Anything else passes through to origin.

import { JSON } from "json-as";
import { Request, Headers, onClientRequest, fetch } from "@automattic/vip-edge-workers-sdk";

export {
  alloc,
  on_client_request,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

@json
class Todo {
  id: i32 = 0;
  userId: i32 = 0;
  title: string = "";
  completed: bool = false;
}

@json
class TodoSummary {
  id: i32 = 0;
  title: string = "";
  done: bool = false;
}

onClientRequest((req: Request): void => {
  if (!req.url.startsWith("/todo/")) return;

  const id = req.url.slice(6); // strip "/todo/"
  const resp = fetch("https://jsonplaceholder.typicode.com/todos/" + id);

  if (resp.isError()) {
    req.respondText(502, "upstream error: " + resp.errorKind!);
    return;
  }

  if (!resp.ok) {
    req.respondText(resp.status, "not found");
    return;
  }

  const body = resp.text();
  if (body === null) { req.respondText(502, "empty response"); return; }
  const todo = JSON.parse<Todo>(body);

  const summary = new TodoSummary();
  summary.id = todo.id;
  summary.title = todo.title;
  summary.done = todo.completed;

  req.respondText(
    200,
    JSON.stringify(summary),
    new Headers([["content-type", "application/json"]]),
  );
});
