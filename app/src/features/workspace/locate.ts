/** 旧提示词控制器与新应用导航之间的局部定位桥；不承载全局事件。 */
export type GlobalLocateRequest = {
  section: "assets" | "prompts";
  id: string;
  inTrash: boolean;
};
