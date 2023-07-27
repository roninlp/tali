"use client";

import { ReactNode, createContext, useReducer } from "react";

interface Project {
  id: number;
  name: string;
  tasks: {
    id: number;
    description?: string;
    type: string;
    date: Date;
  };
}

interface DispatchType {
  id: number;
  type: string;
  text: string;
}

export const ProjectContext = createContext({});

export default function ProjectContextProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(projectReducer, initialProjects);
  return <ProjectContext.Provider value="">{children}</ProjectContext.Provider>;
}

function projectReducer(projects: Project[], action: DispatchType) {}

const initialProjects = [
  {
    id: 0,
    name: "rajabi",
    tasks: [{ id: 0, description: "hi", type: "blog", date: new Date() }],
  },
];
