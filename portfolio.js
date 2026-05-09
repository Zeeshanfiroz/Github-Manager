const projects = [
  {
    title: "GitHub Code Manager",
    type: "tools",
    description:
      "A focused coding dashboard for file edits, branch work, commits, and repository activity.",
    tags: ["VS Code", "GitHub", "Automation"]
  },
  {
    title: "Launch Site Refresh",
    type: "web",
    description:
      "A responsive product site with tighter content structure, better mobile hierarchy, and faster scanning.",
    tags: ["HTML", "CSS", "Accessibility"]
  },
  {
    title: "Design System Starter",
    type: "design",
    description:
      "A practical component foundation with reusable interface patterns, tokens, and interaction states.",
    tags: ["Components", "Tokens", "UX"]
  }
];

const projectGrid = document.querySelector("#projectGrid");
const projectTemplate = document.querySelector("#projectTemplate");
const filterButtons = [...document.querySelectorAll(".filter")];

function renderProjects(filter = "all") {
  const visibleProjects =
    filter === "all" ? projects : projects.filter((project) => project.type === filter);
  const fragment = document.createDocumentFragment();

  for (const project of visibleProjects) {
    const card = projectTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.type = project.type;
    card.querySelector(".project-type").textContent = project.type;
    card.querySelector("h3").textContent = project.title;
    card.querySelector("p").textContent = project.description;

    const tagList = card.querySelector(".tag-list");
    for (const tag of project.tags) {
      const item = document.createElement("li");
      item.textContent = tag;
      tagList.append(item);
    }

    fragment.append(card);
  }

  projectGrid.replaceChildren(fragment);
}

for (const button of filterButtons) {
  button.addEventListener("click", () => {
    for (const current of filterButtons) {
      current.classList.toggle("active", current === button);
    }

    renderProjects(button.dataset.filter);
  });
}

renderProjects();
