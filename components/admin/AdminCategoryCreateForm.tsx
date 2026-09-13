"use client";

import { useRouter } from "next/navigation";
import AdminCategoryForm from "@/components/admin/AdminCategoryForm";
import type { CategoryGameOption } from "@/lib/constants/adminCategories";

/**
 * 新建类目的客户端包装。
 *
 * 存在的理由只有一条：新建成功后要**跳到这条新类目的详情页**。
 * 跳转是客户端行为（`router.push`），而表单本身是纯「填表 → 提交 → 把结果交给父组件」，
 * 两种职责分开之后，编辑页可以复用同一个表单而不必关心自己是新建还是编辑。
 *
 * ⚠️ 跳转用的是**服务端返回的 `categoryId`**，不是「列表里最后一条」之类的前端猜测：
 * 幂等键重放时服务端会把第一次建出来的 id 返回回来，因此重复提交不会跳到别处去。
 */
export default function AdminCategoryCreateForm({ games }: { games: CategoryGameOption[] }) {
  const router = useRouter();

  return (
    <AdminCategoryForm
      record={null}
      games={games}
      onSaved={(result) => {
        router.push(`/admin/categories/${result.categoryId}`);
      }}
    />
  );
}
