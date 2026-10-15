import { Empty, PageHero, PageScrollView } from "./ui";

export function ConstructionPage() {
  return (
    <PageScrollView tabs>
      <PageHero eyebrow="COMING SOON" title="施工中" description="这里的功能还在规划中。" />
      <Empty title="功能待定" icon="construct-outline" />
    </PageScrollView>
  );
}
