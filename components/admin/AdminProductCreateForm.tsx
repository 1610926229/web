"use client";

import { useRouter } from "next/navigation";
import AdminProductForm from "@/components/admin/AdminProductForm";
import type { AdminProductFormOptions } from "@/lib/types/product";

/**
 * 新建商品的客户端包装。
 *
 * 存在的理由只有一条：新建成功后要**跳到这件新商品的详情页**。
 * 跳转是客户端行为（`router.push`），而表单本身是纯「填表 → 提交 → 把结果交给父组件」，
 * 两种职责分开之后，详情页可以复用同一个表单而不必关心自己是新建还是编辑。
 *
 * ⚠️ 跳转用的是**服务端返回的 `productId`**，不是「列表里最后一条」之类的前端猜测：
 * 幂等键重放时服务端会把第一次建出来的 id 返回回来，因此重复提交不会跳到别处去，
 * 也不会在建出第二条商品之后停在原地。
 */
export default function AdminProductCreateForm({ options }: { options: AdminProductFormOptions }) {
  const router = useRouter();

  return (
    <AdminProductForm
      record={null}
      options={options}
      onSaved={(result) => {
        router.push(`/admin/products/${result.productId}`);
      }}
    />
  );
}
