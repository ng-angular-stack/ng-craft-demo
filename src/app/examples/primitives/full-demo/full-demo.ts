import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import {
    asyncProcess,
    cMinLength,
    cRequired,
    insertForm,
    insertFormAttributes,
    insertFormSubmit,
    insertLocalStoragePersister,
    insertNoopTypingAnchor,
    insertPaginationPlaceholderData,
    insertReactOnMutation,
    insertSelectFormTree,
    mutation,
    on$,
    query,
    queryParam,
    reactiveWritableSignal,
    removeMany,
    removeOne,
    source$,
    state,
    updateOne,
    ValidatedFormValue,
    type ExtractDeps,
    type GetDeps,
    type GetPublicComponentProperties
} from '@craft-ng/core';
import { injectApiService, User } from './api.service';

@Component({
  selector: 'app-granular-mutation',
  imports: [CommonModule],
  template: ``,
  styleUrls: ['./full-demo.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export default class FullDemo {
  protected readonly reset$ = source$<void>();

  protected readonly pagination = queryParam(
    {
      state: {
        page: {
          fallbackValue: 1,
          parse: (value) => parseInt(value, 10),
          serialize: (value) => String(value),
        },
        pageSize: {
          fallbackValue: 4,
          parse: (value) => parseInt(value, 10),
          serialize: (value) => String(value),
        },
      },
    },
    ({ patch, state, reset }) => ({
      nextPage: () => patch({ page: state().page + 1 }),
      previousPage: () => patch({ page: state().page - 1 }),
      updatePageSize: (newPageSize: number) => patch({ pageSize: newPageSize, page: 1 }),
      reset: on$(this.reset$, () => reset()),
    }),
  );
  protected readonly apiService = injectApiService();

  protected readonly bulkDelete = mutation({
    method: (ids: string[]) => ids,
    loader: async ({ params: ids }) => {
      await this.apiService.bulkDelete(ids);
      return ids;
    },
  });

  protected readonly delayUserDeletion = asyncProcess({
    method: (payload: { user: User; action: 'delete' | 'cancel' }) => payload,
    identifier: ({ user: { id } }) => id,
    loader: async ({ params: { user, action } }) => {
      if (action === 'cancel') {
        return undefined;
      }
      await wait(5000);
      return user;
    },
  });

  protected readonly deleteUser = mutation({
    fromResourceById: this.delayUserDeletion._resourceById,
    params: (resource) => {
      const value = resource?.safeValue();
      return value
        ? {
            ...value,
            name: value?.name + '-',
          }
        : undefined;
    },
    identifier: ({ id }) => id,
    loader: ({ params: user }) => this.apiService.updateItem(user),
  });

  private readonly updateUserName = mutation({
    method: (payload: NonNullable<ValidatedFormValue<User>>) => payload,
    identifier: ({ id }) => id,
    loader: async ({ params: user }) => this.apiService.updateItem(user),
  });

  private readonly usersQuery = query(
    {
      params: this.pagination,
      identifier: (params) => `${params.page}-${params.pageSize}`,
      loader: ({ params: pagination }) => this.apiService.getDataList(pagination),
    },
    insertLocalStoragePersister({
      storeName: 'demo-app-full-demo',
      key: 'granular',
    }),
    insertPaginationPlaceholderData,
    insertReactOnMutation(this.deleteUser, {
      filter: ({ mutationIdentifier, queryResource }) =>
        !!queryResource.safeValue()?.some((item) => item.id === mutationIdentifier),
      optimisticUpdate: ({ queryResource, mutationIdentifier }) =>
        removeOne({
          entities: queryResource.value(),
          id: mutationIdentifier,
        }),
      reload: {
        onMutationError: true,
      },
    }),
    insertReactOnMutation(this.deleteUser, {
      filter: ({ queryResource }) => queryResource.safeValue()?.length === 0,
      reload: {
        // reload the current page if there is no more data after mutation
        onMutationResolved: true,
      },
    }),
    insertReactOnMutation(this.bulkDelete, {
      filter: ({ queryResource }) => (queryResource.safeValue()?.length ?? 0) > 0,
      optimisticUpdate: ({ queryResource, mutationParams }) =>
        removeMany({
          entities: queryResource.value(),
          ids: mutationParams,
        }),
      reload: {
        onMutationError: true,
      },
    }),
    insertReactOnMutation(this.bulkDelete, {
      filter: ({ queryResource }) => queryResource.safeValue()?.length === 0,
      reload: {
        // reload the current page if there is no more data after mutation
        onMutationResolved: ({ queryResource }) => queryResource.safeValue()?.length === 0,
      },
    }),
    insertReactOnMutation(this.updateUserName, {
      filter: ({ mutationIdentifier, queryResource }) =>
        !!queryResource.safeValue()?.some((item) => item.id === mutationIdentifier),
      optimisticUpdate: ({ queryResource, mutationParams }) =>
        updateOne({
          entities: queryResource.value(),
          update: {
            id: mutationParams.id,
            changes: mutationParams,
          },
        }),
      reload: {
        onMutationError: true,
      },
    }),
  );

  private readonly currentUsersPageResource = computed(() => {
    const currentIdentifier = this.usersQuery.currentIdentifier();
    if (!currentIdentifier) {
      return undefined;
    }

    return this.usersQuery.select(currentIdentifier);
  });

  protected readonly usersByPage = state(
    computed(() => this.usersQuery.currentPageData() ?? []),
    () => ({
      status: computed(() =>
        this.currentUsersPageResource()?.hasException()
          ? 'exception'
          : (this.currentUsersPageResource()?.status() ?? 'idle'),
      ),
      isLoading: computed(() => this.currentUsersPageResource()?.isLoading() ?? false),
      exceptions: computed(() => this.currentUsersPageResource()?.exceptions()),
      displayUsers: computed(() => !!this.usersQuery.currentPageData()?.length),
    }),
    insertForm(
      { identifier: ({ item: { id } }) => id },
      insertFormSubmit(this.updateUserName),
      insertSelectFormTree(
        'name',
        insertNoopTypingAnchor,
        insertFormAttributes(() => ({
          validators: [cRequired(), cMinLength({ minLength: 3 })],
        })),
      ),
      () => {
        const isEditing = signal<boolean>(false);

        return {
          isEditing: isEditing.asReadonly(),
          toggleEditing: () => isEditing.update((v) => !v),
        };
      },
    ),
    ({ state, insertions: { select } }) => ({
      // due to a formField directive error, we need to disable pagination while editing
      disablePaginationWhileEditing: computed(() =>
        state().some(({ id }) => select(id)()?.isEditing()),
      ),
    }),
  );

  protected readonly selectedRows = state(
    reactiveWritableSignal([] as string[], (sync) => ({
      resetWhenCurrentPageIsResolved: sync(
        this.usersQuery.currentPageStatus,
        ({ params, current }) => (params === 'resolved' ? [] : current),
      ),
      resetWhenBulkDeleteIsResolved: sync(this.bulkDelete.status, ({ params, current }) =>
        params === 'resolved' ? [] : current,
      ),
      removeDeletedItemsWhenDeleteUserIsResolved: sync(
        this.delayUserDeletion.changes.resolved,
        ({ params: resolvedIds, current }) =>
          resolvedIds.length > 0
            ? removeMany({
                entities: current,
                ids: resolvedIds,
              })
            : current,
      ),
    })),
    ({ state: selectedRows }) => ({
      isAllSelected: computed(
        () =>
          this.usersQuery.currentPageData()?.length &&
          this.usersQuery.currentPageData()?.every((user) => selectedRows().includes(user.id)),
      ),
    }),
    ({ update, set, state: selectedRows, insertions: { isAllSelected } }) => ({
      toggleSelection: (id: string) =>
        update((current) =>
          current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
        ),
      isSelected: (id: string) => selectedRows().includes(id),
      isAllSelected,
      isSomeSelected: computed(
        () =>
          this.usersQuery.currentPageData()?.some((user) => selectedRows().includes(user.id)) &&
          !isAllSelected(),
      ),
      toggleAllSelection: () => {
        if (isAllSelected()) {
          set([]);
        } else {
          const allIds = this.usersQuery.currentPageData()?.map((user) => user.id) || [];
          set(allIds);
        }
      },
      reset: on$(this.reset$, () => set([])),
    }),
  );

  protected updatePageSize(event: Event) {
    const value = Number((event.target as HTMLSelectElement).value);
    this.pagination.updatePageSize(value);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GenDeps_FullDemo = GetDeps<{
      deps: {
        CommonModule: CommonModule;
      };
      propertiesDeps: {
        reset$: ExtractDeps<FullDemo["reset$"]>;
        pagination: ExtractDeps<FullDemo["pagination"]>;
        apiService: {
            ApiService: ExtractDeps<typeof injectApiService>["ApiService"];
          };
        bulkDelete: ExtractDeps<FullDemo["bulkDelete"]>;
        delayUserDeletion: ExtractDeps<FullDemo["delayUserDeletion"]>;
        deleteUser: ExtractDeps<FullDemo["deleteUser"]>;
        updateUserName: ExtractDeps<FullDemo["updateUserName"]>;
        usersQuery: ExtractDeps<FullDemo["usersQuery"]>;
        currentUsersPageResource: ExtractDeps<FullDemo["currentUsersPageResource"]>;
        usersByPage: ExtractDeps<FullDemo["usersByPage"]>;
        selectedRows: ExtractDeps<FullDemo["selectedRows"]>;
      };
      provided: {};
      publicProperties: GetPublicComponentProperties<FullDemo>;
    }>;
