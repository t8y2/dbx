use crate::{IntoSql, TokenRow};

/// create a TokenRow from list of values
pub trait IntoRow<'a> {
    /// create a TokenRow from list of values which implements IntoSQL
    fn into_row(self) -> TokenRow<'a>;
}

impl<'a, A> IntoRow<'a> for A
where
    A: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.into_sql());
        row
    }
}

impl<'a, A, B> IntoRow<'a> for (A, B)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row
    }
}

impl<'a, A, B, C> IntoRow<'a> for (A, B, C)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row
    }
}

impl<'a, A, B, C, D> IntoRow<'a> for (A, B, C, D)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
    D: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row.push(self.3.into_sql());
        row
    }
}

impl<'a, A, B, C, D, E> IntoRow<'a> for (A, B, C, D, E)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
    D: IntoSql<'a>,
    E: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row.push(self.3.into_sql());
        row.push(self.4.into_sql());
        row
    }
}

impl<'a, A, B, C, D, E, F> IntoRow<'a> for (A, B, C, D, E, F)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
    D: IntoSql<'a>,
    E: IntoSql<'a>,
    F: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row.push(self.3.into_sql());
        row.push(self.4.into_sql());
        row.push(self.5.into_sql());
        row
    }
}

impl<'a, A, B, C, D, E, F, G> IntoRow<'a> for (A, B, C, D, E, F, G)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
    D: IntoSql<'a>,
    E: IntoSql<'a>,
    F: IntoSql<'a>,
    G: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row.push(self.3.into_sql());
        row.push(self.4.into_sql());
        row.push(self.5.into_sql());
        row.push(self.6.into_sql());
        row
    }
}

impl<'a, A, B, C, D, E, F, G, H> IntoRow<'a> for (A, B, C, D, E, F, G, H)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
    D: IntoSql<'a>,
    E: IntoSql<'a>,
    F: IntoSql<'a>,
    G: IntoSql<'a>,
    H: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row.push(self.3.into_sql());
        row.push(self.4.into_sql());
        row.push(self.5.into_sql());
        row.push(self.6.into_sql());
        row.push(self.7.into_sql());
        row
    }
}

impl<'a, A, B, C, D, E, F, G, H, I> IntoRow<'a> for (A, B, C, D, E, F, G, H, I)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
    D: IntoSql<'a>,
    E: IntoSql<'a>,
    F: IntoSql<'a>,
    G: IntoSql<'a>,
    H: IntoSql<'a>,
    I: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row.push(self.3.into_sql());
        row.push(self.4.into_sql());
        row.push(self.5.into_sql());
        row.push(self.6.into_sql());
        row.push(self.7.into_sql());
        row.push(self.8.into_sql());
        row
    }
}

impl<'a, A, B, C, D, E, F, G, H, I, J> IntoRow<'a> for (A, B, C, D, E, F, G, H, I, J)
where
    A: IntoSql<'a>,
    B: IntoSql<'a>,
    C: IntoSql<'a>,
    D: IntoSql<'a>,
    E: IntoSql<'a>,
    F: IntoSql<'a>,
    G: IntoSql<'a>,
    H: IntoSql<'a>,
    I: IntoSql<'a>,
    J: IntoSql<'a>,
{
    fn into_row(self) -> TokenRow<'a> {
        let mut row = TokenRow::new();
        row.push(self.0.into_sql());
        row.push(self.1.into_sql());
        row.push(self.2.into_sql());
        row.push(self.3.into_sql());
        row.push(self.4.into_sql());
        row.push(self.5.into_sql());
        row.push(self.6.into_sql());
        row.push(self.7.into_sql());
        row.push(self.8.into_sql());
        row.push(self.9.into_sql());
        row
    }
}
