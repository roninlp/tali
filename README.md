# TaLi App

TaLi is a simple project management app that focuses on rich calendar feature and simple interactions without too much fuss.

## Thoughts behind this project

This app was inspired by my wife who is a freelance content writer who works for different companies and teams each month.

She always talked about how none of the other task and project management tools couldn't do what exactly she wanted. And how she couldn't stick to anyone of them. So she resorted to just plain pen and paper in her bullet journal.

I wanted to help her by creating what she had in mind for a project manager.

Thats where TaLi comes in.

## Main features

The main feature is a calendar view wher you can see all the tasks and projects in a month.
You can Add Projects, and you can create tasks wihtin those projects in any day.

You can see the progress of each project as in how many of the tasks are done.

Later on I'm thinking about adding different views like a weekly and daily view.

Also a Project view to see all the tasks in a single project.

## Tech Stack

- Framework:

  I'm using [Next.js](https://nextjs.org/docs), specifiecly Next.js 13 App dir as the framework for this app. With the help of [Typescript](https://www.typescriptlang.org/)

- Database:

  My database of choice is [Supabase](https://supabase.com/).
  I don't use any third-party ORM since the JS client of supabse gets the job done easily.

- Auth:

  For auth I'm also using [Supabase Auth](https://supabase.com/docs/guides/auth) which seems more straigh forward to use than to use other solutions like Next auth and Clerk.

- Components:

  this was a no-brainer for me. I went with [shadcn-ui](https://ui.shadcn.com/). Which is a very developer friendly and extensive collection of re-usable components. It is built on top of [radix-ui](https://www.radix-ui.com/) and styled with [Tailwind CSS](https://tailwindcss.com/) with the help of things like [cva](https://cva.style/). It is not like other component libraries. The code is yours to costumize and you can make anything you want easily. This is the first time I'm using it and it did not dissappoint.

## Check it out yourself

Just clone this repo to your system and run the dev server:
Make sure that you have a supabase database setup and add the supabse url and anon key to your .env

```bash
pnpm install
pnpm dev
```

then open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
