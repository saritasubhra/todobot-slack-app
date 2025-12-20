import dotenv from "dotenv";
import pkg from "@slack/bolt";

import { randomUUID } from "crypto";
import { connectDB } from "./db.js";
import { Installation } from "./models/Installation.js";
import { Todo } from "./models/Todo.js";
dotenv.config();

const { App, ExpressReceiver } = pkg;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.STATE_SECRET || "a-very-secret-value",
  scopes: ["commands", "chat:write", "app_home:opened", "users:read"],
  installationStore: {
    storeInstallation: async (installation) => {
      if (installation.team) {
        return await Installation.findOneAndUpdate(
          { teamId: installation.team.id },
          { teamId: installation.team.id, installation },
          { upsert: true }
        );
      }
      throw new Error("Failed saving installation");
    },
    fetchInstallation: async (installQuery) => {
      const result = await Installation.findOne({
        teamId: installQuery.teamId,
      });
      if (!result) {
        throw new Error("No installation found");
      }
      return result.installation;
    },
  },
  installerOptions: {
    directInstall: true,
  },
});

// Pass the fully configured receiver to the App
const app = new App({
  receiver,
});

// 👇 ADD THIS BELOW app initialization
receiver.app.get("/slack/oauth_redirect", (req, res) => {
  res.send("✅ TodoApp installed successfully. You can close this window.");
});

const userFilters = {};
// userFilters[userId] = "overdue" | "upcoming" | "inbox"

const getFilter = (userId) => userFilters[userId] || "inbox";

app.event("app_home_opened", async ({ event, client }) => {
  await client.views.publish({
    user_id: event.user,
    view: await homeTabView(event.user),
  });
});

app.action("open_new_todo", async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: newTodoModal(),
  });
});

/* -------------------- SLASH COMMAND -------------------- */
app.command("/todo", async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: newTodoModal(),
  });
});

/* -------------------- CREATE TODO -------------------- */
app.view("create_todo", async ({ ack, body, view, client }) => {
  await ack();

  const userId = body.user.id;

  const text = view.state.values.todo_text.text_input.value;
  const dueDate = view.state.values.todo_due?.due_date?.selected_date || null;
  const assignee =
    view.state.values.todo_assign?.assignee?.selected_user || userId;

  await Todo.create({
    userId,
    text,
    dueDate,
    assignee,
  });

  await client.views.publish({
    user_id: userId,
    view: await homeTabView(userId),
  });
});

/* -------------------- EDIT TODO -------------------- */
app.action("edit_todo", async ({ ack, body, client }) => {
  await ack();

  const todoId = body.actions[0].value;
  const userId = body.user.id;

  const todo = await Todo.findOne({ _id: todoId, userId });
  if (!todo) return;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: editTodoModal(todo),
  });
});

/* -------------------- UPDATE TODO -------------------- */
app.view("update_todo", async ({ ack, body, view, client }) => {
  await ack();

  const userId = body.user.id;
  const todoId = view.private_metadata;

  await Todo.findOneAndUpdate(
    { _id: todoId, userId },
    {
      text: view.state.values.todo_text.text_input.value,
      dueDate: view.state.values.todo_due?.due_date?.selected_date || null,
      assignee:
        view.state.values.todo_assign?.assignee?.selected_user || userId,
    }
  );

  await client.chat.postMessage({
    channel: userId,
    text: "Todo updated successfully",
  });

  await client.views.publish({
    user_id: userId,
    view: await homeTabView(userId),
  });
});

app.action("complete_todo", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const todoId = body.actions[0].value;

  await Todo.findOneAndUpdate(
    { _id: todoId, userId },
    { completed: true, completedAt: new Date() }
  );

  await client.views.publish({
    user_id: userId,
    view: await homeTabView(userId),
  });
});

app.action("delete_todo", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const todoId = body.actions[0].value;

  await Todo.deleteOne({ _id: todoId, userId });

  await client.views.publish({
    user_id: userId,
    view: await homeTabView(userId),
  });
});

app.action("change_filter", async ({ ack, body, client }) => {
  await ack();

  const userId = body.user.id;
  const selected = body.actions[0].selected_option.value;

  userFilters[userId] = selected;

  await client.views.publish({
    user_id: userId,
    view: await homeTabView(userId),
  });
});

/* -------------------- BLOCKS -------------------- */
const todoBlock = (todo) => [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${todo.text}*\nDue: ${todo.dueDate || "—"}`,
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Edit & Assign" },
      action_id: "edit_todo",
      value: todo.id,
      style: "primary",
    },
  },
];

const isUpcoming = (todo) => {
  if (!todo.dueDate || todo.completed) return false;
  return new Date(todo.dueDate) >= new Date();
};

const isInbox = (todo) => {
  return !todo.dueDate && !todo.completed;
};

/* -------------------- MODALS -------------------- */
const newTodoModal = () => ({
  type: "modal",
  callback_id: "create_todo",
  title: { type: "plain_text", text: "New ToDo" },
  submit: { type: "plain_text", text: "Save" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Create a new task",
      },
    },
    {
      type: "input",
      block_id: "todo_text",
      element: {
        type: "plain_text_input",
        action_id: "text_input",
        multiline: true,
        placeholder: { type: "plain_text", text: "Write something..." },
      },
      label: { type: "plain_text", text: "ToDo text" },
    },
    {
      type: "input",
      block_id: "todo_assign",
      optional: true,
      element: {
        type: "users_select",
        action_id: "assignee",
        placeholder: { type: "plain_text", text: "Select user" },
      },
      label: { type: "plain_text", text: "Assigned to" },
    },
    {
      type: "input",
      block_id: "todo_due",
      optional: true,
      element: {
        type: "datepicker",
        action_id: "due_date",
      },
      label: { type: "plain_text", text: "Due date" },
    },
  ],
});

const editTodoModal = (todo) => ({
  type: "modal",
  callback_id: "update_todo",
  private_metadata: todo._id.toString(),
  title: { type: "plain_text", text: "Edit ToDo" },
  submit: { type: "plain_text", text: "Update" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Update your task",
      },
    },
    {
      type: "input",
      block_id: "todo_text",
      element: {
        type: "plain_text_input",
        action_id: "text_input",
        initial_value: todo.text || "",
        multiline: true,
      },
      label: { type: "plain_text", text: "ToDo text" },
    },
    {
      type: "input",
      block_id: "todo_assign",
      optional: true,
      element: {
        type: "users_select",
        action_id: "assignee",
        ...(todo.assignee ? { initial_user: todo.assignee } : {}),
      },
      label: { type: "plain_text", text: "Assigned to" },
    },
    {
      type: "input",
      block_id: "todo_due",
      optional: true,
      element: {
        type: "datepicker",
        action_id: "due_date",
        ...(todo.dueDate ? { initial_date: todo.dueDate } : {}),
      },
      label: { type: "plain_text", text: "Due date" },
    },
  ],
});

const isOverdue = (todo) => {
  if (!todo.dueDate || todo.completed) return false;
  return new Date(todo.dueDate) < new Date();
};

const homeTabView = async (userId) => {
  // const userTodos = todos[userId] || [];

  const userTodos = await Todo.find({ userId }).sort({
    completed: 1,
    dueDate: 1,
  });

  const openTodos = userTodos.filter((t) => !t.completed);
  const completedTodos = userTodos.filter((t) => t.completed);

  const blocks = [];

  const filter = getFilter(userId);

  let visibleTodos = openTodos;

  if (filter === "overdue") {
    visibleTodos = openTodos.filter(isOverdue);
  }

  if (filter === "upcoming") {
    visibleTodos = openTodos.filter(isUpcoming);
  }

  if (filter === "inbox") {
    visibleTodos = openTodos;
  }

  // Header
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: "Your To-Do List",
    },
  });

  // Count
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*You have ${openTodos.length} open ToDo(s)*`,
    },
  });

  // New Todo button
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "New Todo" },
        style: "primary",
        action_id: "open_new_todo",
      },
    ],
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*View*",
    },
    accessory: {
      type: "radio_buttons",
      action_id: "change_filter",
      options: [
        {
          text: { type: "plain_text", text: "Overdue" },
          value: "overdue",
        },
        {
          text: { type: "plain_text", text: "Upcoming" },
          value: "upcoming",
        },
        {
          text: { type: "plain_text", text: "Inbox" },
          value: "inbox",
        },
      ],
      initial_option: {
        text: {
          type: "plain_text",
          text:
            getFilter(userId).charAt(0).toUpperCase() +
            getFilter(userId).slice(1),
        },
        value: getFilter(userId),
      },
    },
  });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        filter === "overdue"
          ? "Overdue"
          : filter === "upcoming"
          ? "Upcoming"
          : "*Inbox*",
    },
  });

  // Open todos
  if (visibleTodos.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No todos yet. Click *New Todo* to create one._",
      },
    });
  } else {
    visibleTodos.forEach((todo) => {
      const overdue = isOverdue(todo);

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: overdue
            ? `*${todo.text}*\n*Overdue:* ${todo.dueDate}`
            : `*${todo.text}*\nDue: ${todo.dueDate || "—"}`,
        },
      });

      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Complete" },
            action_id: "complete_todo",
            value: todo.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Edit & Assign" },
            action_id: "edit_todo",
            value: todo.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Delete" },
            action_id: "delete_todo",
            value: todo.id,
            style: "danger",
          },
        ],
      });

      blocks.push({ type: "divider" });
    });
  }

  // Recently completed
  if (completedTodos.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*✅ Recently Completed:*",
      },
    });

    completedTodos.slice(0, 3).forEach((todo) => {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `~${todo.text}~`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Delete" },
          action_id: "delete_todo",
          value: todo.id,
          style: "danger",
        },
      });
    });
  }

  return {
    type: "home",
    blocks,
  };
};

/* -------------------- START APP -------------------- */
(async () => {
  await connectDB();
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ TodoBot is running");
})();
